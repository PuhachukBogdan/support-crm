import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  OnModuleInit,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Request, Response } from 'express';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';
import { Public } from './public.decorator';
import { clearSessionCookies, setSessionCookies } from './session-cookie';
import type { RequestClaims } from './auth.guard';

// AuthService methods as delivered by proto-loader (enum NAMES as strings, int64 as strings).
interface AuthGrpc {
  login(data: {
    email: string;
    password: string;
  }): Observable<{ status: string; challengeId: string; codeExpiresAt: string }>;
  verifyLoginCode(data: {
    challengeId: string;
    code: string;
    rememberMe: boolean;
  }): Observable<{
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: string;
    refreshExpiresAt: string;
  }>;
}

interface LoginBody {
  email: string;
  password: string;
}
interface VerifyBody {
  challengeId: string;
  code: string;
  rememberMe?: boolean;
}

/**
 * Gateway session edge (feature 009, T019). Translates the AuthService gRPC surface into REST
 * + httpOnly cookies (contracts/gateway-rest.md). NO business logic here (Principle VIII) — the
 * gateway sets/clears cookies and forwards; credential/code/token decisions are Auth's. No token,
 * code, or password ever appears in a response body or log.
 */
@Controller('auth')
export class AuthController implements OnModuleInit {
  private auth!: AuthGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<AuthGrpc>('AuthService');
  }

  /** Step 1 — email + password → a challenge. No cookie is set here. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response) {
    const r = await firstValueFrom(
      this.auth.login({ email: body.email, password: body.password }),
    );
    if (r.status === 'CODE_SENT') {
      return { status: 'code_sent', challengeId: r.challengeId, codeExpiresAt: Number(r.codeExpiresAt) };
    }
    if (r.status === 'LOCKED') {
      res.status(HttpStatus.LOCKED);
      return { status: 'locked' };
    }
    // Same body for unknown email and wrong password (no enumeration — FR-001).
    res.status(HttpStatus.UNAUTHORIZED);
    return { status: 'invalid_credentials' };
  }

  /** Step 2 — challenge + code → session cookies. */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: VerifyBody, @Res({ passthrough: true }) res: Response) {
    const rememberMe = body.rememberMe === true;
    try {
      const pair = await firstValueFrom(
        this.auth.verifyLoginCode({ challengeId: body.challengeId, code: body.code, rememberMe }),
      );
      setSessionCookies(
        res,
        {
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          accessMaxAgeSec: this.cfg.ACCESS_TTL,
          refreshMaxAgeSec: rememberMe ? this.cfg.REMEMBER_TTL : this.cfg.SESSION_TTL,
        },
        { secure: this.cfg.COOKIE_SECURE },
      );
      return { status: 'ok' };
    } catch {
      // Generic — wrong/expired/consumed/exhausted are indistinguishable to the caller.
      clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'invalid_code' };
    }
  }

  /** Convenience — the current identity from the validated session (protected by the guard). */
  @Get('me')
  me(@Req() req: Request & { claims?: RequestClaims }) {
    const claims = req.claims;
    return { userId: claims?.userId, accountId: claims?.accountId, roles: claims?.roles ?? [] };
  }
}
