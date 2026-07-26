import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  OnModuleInit,
  Post,
  Res,
} from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';
import { Public } from './public.decorator';
import { setSessionCookies, type SessionTokens } from './session-cookie';

interface TokenPairWire {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}
interface RegistrationGrpc {
  startRegistration(data: {
    inviteToken: string;
    email: string;
  }): Observable<{ status: string; codeExpiresAt: string }>;
  completeRegistration(data: {
    inviteToken: string;
    email: string;
    code: string;
    password: string;
  }): Observable<TokenPairWire>;
}

interface StartBody {
  token: string;
  email: string;
}
interface CompleteBody {
  token: string;
  email: string;
  code: string;
  password: string;
}

/**
 * Gateway edge for registration via invite (feature 010, roadmap 3.10). `@Public` — reached from
 * the emailed invite link before any session exists. Thin: forwards to `AuthService`, sets the
 * httpOnly session on success, maps weak-password → 422 and other failures → 401.
 */
@Controller('auth')
export class RegistrationController implements OnModuleInit {
  private auth!: RegistrationGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<RegistrationGrpc>('AuthService');
  }

  private cookiesFromPair(pair: TokenPairWire): SessionTokens {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessMaxAgeSec: Math.max(1, Number(pair.accessExpiresAt) - nowSec),
      refreshMaxAgeSec: Math.max(1, Number(pair.refreshExpiresAt) - nowSec),
    };
  }

  @Public()
  @Post('register/start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() body: StartBody, @Res({ passthrough: true }) res: Response) {
    const r = await firstValueFrom(
      this.auth.startRegistration({ inviteToken: body.token, email: body.email }),
    );
    if (r.status === 'REGISTRATION_CODE_SENT') {
      return { status: 'code_sent', codeExpiresAt: Number(r.codeExpiresAt) };
    }
    res.status(HttpStatus.UNAUTHORIZED);
    return { status: 'invalid' };
  }

  @Public()
  @Post('register/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() body: CompleteBody, @Res({ passthrough: true }) res: Response) {
    try {
      const pair = await firstValueFrom(
        this.auth.completeRegistration({
          inviteToken: body.token,
          email: body.email,
          code: body.code,
          password: body.password,
        }),
      );
      setSessionCookies(res, this.cookiesFromPair(pair), { secure: this.cfg.COOKIE_SECURE });
      return { status: 'ok' };
    } catch (err) {
      if ((err as { code?: number }).code === GrpcStatus.INVALID_ARGUMENT) {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        return { status: 'weak_password' };
      }
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'invalid' };
    }
  }
}
