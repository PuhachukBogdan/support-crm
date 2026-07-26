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

// AuthService methods as delivered by proto-loader (int64 as strings).
interface TokenPairWire {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}
interface OnboardingGrpc {
  requestActivation(data: { email: string }): Observable<Record<string, never>>;
  completeActivation(data: {
    email: string;
    code: string;
    password: string;
  }): Observable<TokenPairWire>;
}

interface ActivateRequestBody {
  email: string;
}
interface ActivateCompleteBody {
  email: string;
  code: string;
  password: string;
}

/**
 * Gateway edge for super-admin whitelist onboarding (feature 010, roadmap 3.8). Thin: forwards to
 * `AuthService` over gRPC and sets the httpOnly session on success. `activate/request` is uniform
 * (anti-enumeration); `activate/complete` maps the gRPC failure code to 422 (weak password) vs 401
 * (bad code / not eligible). No business logic here (Principle VIII).
 */
@Controller('auth')
export class OnboardingController implements OnModuleInit {
  private auth!: OnboardingGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<OnboardingGrpc>('AuthService');
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

  /** Generic activation entry — identical response for any email (anti-enumeration). */
  @Public()
  @Post('activate/request')
  @HttpCode(HttpStatus.OK)
  async request(@Body() body: ActivateRequestBody) {
    await firstValueFrom(this.auth.requestActivation({ email: body.email }));
    return { status: 'requested' };
  }

  /** Finish activation — sets the session on success. */
  @Public()
  @Post('activate/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() body: ActivateCompleteBody, @Res({ passthrough: true }) res: Response) {
    try {
      const pair = await firstValueFrom(
        this.auth.completeActivation({
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
