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
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
  type SessionTokens,
} from './session-cookie';
import type { RequestClaims } from './auth.guard';

// AuthService methods as delivered by proto-loader (enum NAMES as strings, int64 as strings).
interface TokenPairWire {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}
interface AuthGrpc {
  login(data: {
    email: string;
    password: string;
  }): Observable<{ status: string; challengeId: string; codeExpiresAt: string }>;
  verifyLoginCode(data: {
    challengeId: string;
    code: string;
    rememberMe: boolean;
  }): Observable<TokenPairWire>;
  refresh(data: { refreshToken: string }): Observable<TokenPairWire>;
  logout(data: { refreshToken: string }): Observable<{ revoked: boolean }>;
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

  /** Cookie maxAges derived from the authoritative expiries auth returned (respects 1d/7d). */
  private cookiesFromPair(pair: TokenPairWire): SessionTokens {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessMaxAgeSec: Math.max(1, Number(pair.accessExpiresAt) - nowSec),
      refreshMaxAgeSec: Math.max(1, Number(pair.refreshExpiresAt) - nowSec),
    };
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
      setSessionCookies(res, this.cookiesFromPair(pair), { secure: this.cfg.COOKIE_SECURE });
      return { status: 'ok' };
    } catch {
      // Generic — wrong/expired/consumed/exhausted are indistinguishable to the caller.
      clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'invalid_code' };
    }
  }

  /** Rotate the session from the refresh cookie. Public: it must work once the access token expired. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!raw) {
      clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'unauthorized' };
    }
    try {
      const pair = await firstValueFrom(this.auth.refresh({ refreshToken: raw }));
      setSessionCookies(res, this.cookiesFromPair(pair), { secure: this.cfg.COOKIE_SECURE });
      return { status: 'ok' };
    } catch {
      clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'unauthorized' };
    }
  }

  /** End the session: revoke the refresh token and clear both cookies (always). */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (raw) {
      try {
        await firstValueFrom(this.auth.logout({ refreshToken: raw }));
      } catch {
        // Revocation best-effort; cookies are cleared regardless.
      }
    }
    clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
    return { status: 'logged_out' };
  }

  /** Convenience — the current identity from the validated session (protected by the guard). */
  @Get('me')
  me(@Req() req: Request & { claims?: RequestClaims }) {
    const claims = req.claims;
    return { userId: claims?.userId, accountId: claims?.accountId, roles: claims?.roles ?? [] };
  }
}
