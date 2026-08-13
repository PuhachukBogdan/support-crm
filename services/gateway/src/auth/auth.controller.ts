import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  OnModuleInit,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
// ⭐ W36 / 041: the change rpc needs the caller's identity forwarded — the same builder every guarded
// edge uses, so the owning service sees the SAME actor headers it sees everywhere else.
import { buildActorMetadata } from '../chats/actor-metadata';
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
import { EnsureOperatorProfile } from './ensure-operator-profile';
import type { RequestClaims } from './auth.guard';
import type { EffectivePermissions } from '@crm/common';
import { ResolvesPermissions } from '../security/requires-permission.decorator';

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
  // ⭐ W36 / 041 — recovery and the signed-in change.
  requestPasswordRecovery(data: { email: string; sourceRef: string }): Observable<Record<string, never>>;
  completePasswordRecovery(data: {
    token: string;
    password: string;
  }): Observable<{ outcome?: string; revokedCount?: number; failures?: string[] }>;
  changeOwnPassword(
    data: { currentPassword: string; newPassword: string },
    md?: unknown,
  ): Observable<{ outcome?: string; revokedCount?: number; failures?: string[] }>;
}

/**
 * ⭐ W36 / 041 — the outcome word → HTTP status.
 *
 * ⚠️ **An unrecognised outcome, including the zero value the wire drops, is a 500 — never a success.**
 * `gotchas/grpc-wire-encoding-enums-longs`, the fourth instance in this project.
 *
 * ⓘ `needs no cookie` is the property this table cannot express and a test must: `complete` sets none.
 */
const RECOVERY_STATUS: Readonly<Record<string, { http: number; word: string }>> = {
  RECOVERY_OUTCOME_OK: { http: HttpStatus.OK, word: 'ok' },
  '1': { http: HttpStatus.OK, word: 'ok' },
  RECOVERY_OUTCOME_BAD_TOKEN: { http: HttpStatus.BAD_REQUEST, word: 'bad_token' },
  '2': { http: HttpStatus.BAD_REQUEST, word: 'bad_token' },
  // 410 GONE, deliberately: the link EXISTED and no longer does, which is a different fact from «wrong
  // link» and the one the screen turns into «ask for a new one».
  RECOVERY_OUTCOME_EXPIRED: { http: HttpStatus.GONE, word: 'expired' },
  '3': { http: HttpStatus.GONE, word: 'expired' },
  RECOVERY_OUTCOME_ALREADY_USED: { http: HttpStatus.GONE, word: 'already_used' },
  '4': { http: HttpStatus.GONE, word: 'already_used' },
  RECOVERY_OUTCOME_WEAK_PASSWORD: { http: HttpStatus.UNPROCESSABLE_ENTITY, word: 'weak_password' },
  '5': { http: HttpStatus.UNPROCESSABLE_ENTITY, word: 'weak_password' },
  RECOVERY_OUTCOME_NOT_ELIGIBLE: { http: HttpStatus.FORBIDDEN, word: 'not_eligible' },
  '6': { http: HttpStatus.FORBIDDEN, word: 'not_eligible' },
};

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
    // MVP block W1 (roadmap 5.10): this is also the REPAIR path — everyone who registered before the
    // profile existed gets one on their next sign-in, instead of a hand-written INSERT.
    @Inject(EnsureOperatorProfile) private readonly profile: EnsureOperatorProfile,
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

  /**
   * ⭐ W36 / 041 — ask for a recovery link (roadmap 3.18).
   *
   * ⚠️ **ALWAYS 202 with the same body.** Known address, unknown address, no password yet, deactivated,
   * rate-capped — one answer, because a form that varies is a directory of who works here. There is no
   * branch in this method to get wrong: the rpc returns nothing to branch on.
   *
   * ⚠️ `sourceRef` comes from the CONNECTION, never from the body — a client-supplied one would make the
   * per-source limit self-service. A body field claiming to be it is a 400.
   */
  @Public()
  @Post('recovery')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestRecovery(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const unknown = Object.keys(body ?? {}).filter((k) => k !== 'email');
    if (unknown.length > 0) throw new BadRequestException(`unknown field: ${unknown.sort().join(', ')}`);
    const email = typeof body?.email === 'string' ? body.email : '';
    // ⓘ No validation of the address SHAPE here on purpose: refusing a malformed one would answer
    // differently for «not an email» than for «an email nobody has», which is a smaller version of the
    // same leak. The service treats anything unmatched as unknown.
    await firstValueFrom(
      this.auth.requestPasswordRecovery({ email, sourceRef: this.sourceRef(req) }),
    );
    return { status: 'accepted' };
  }

  /**
   * ⭐ W36 / 041 — use the link. ⛔ **Sets NO cookie**, and `no-session-from-recovery.spec.ts` asserts it:
   * recovery proves a mailbox and sets a password; the two-step login is not bypassed (FR-009, overriding
   * roadmap 8.11's «and signs them in»).
   */
  @Public()
  @Post('recovery/complete')
  @HttpCode(HttpStatus.OK)
  async completeRecovery(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = typeof body?.token === 'string' ? body.token : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!token || !password) throw new BadRequestException('token and password are required');

    const r = await firstValueFrom(this.auth.completePasswordRecovery({ token, password }));
    const mapped = RECOVERY_STATUS[String(r?.outcome ?? '')];
    // An outcome nobody declared is an upstream error, never a success.
    if (!mapped) throw new InternalServerErrorException('upstream error');
    res.status(mapped.http);
    return {
      outcome: mapped.word,
      revokedCount: Number(r?.revokedCount ?? 0),
      ...(mapped.word === 'weak_password' ? { failures: (r?.failures ?? []).map(String) } : {}),
    };
  }

  /**
   * ⭐ W36 / 041 — change your own password. GUARDED: no `@Public()`.
   *
   * ⚠️ The caller's own session is among the revoked, so this clears the cookies too — leaving them set
   * would show somebody a signed-in shell whose every renewal is already dead, which is worse than
   * signing them out.
   */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('currentPassword and newPassword are required');
    }

    const claims = (req as Request & { claims?: { sub?: string; accountId?: string } }).claims;
    const r = await firstValueFrom(
      this.auth.changeOwnPassword(
        { currentPassword, newPassword },
        buildActorMetadata(claims as never, undefined),
      ),
    );
    const mapped = RECOVERY_STATUS[String(r?.outcome ?? '')];
    if (!mapped) throw new InternalServerErrorException('upstream error');
    if (mapped.word === 'ok') clearSessionCookies(res, { secure: this.cfg.COOKIE_SECURE });
    // A wrong CURRENT password is a 401, not a 400: it is a failed authentication, and it counts toward
    // the same lockout the login path uses.
    res.status(mapped.word === 'bad_token' ? HttpStatus.UNAUTHORIZED : mapped.http);
    return {
      outcome: mapped.word === 'bad_token' ? 'invalid_credentials' : mapped.word,
      revokedCount: Number(r?.revokedCount ?? 0),
      ...(mapped.word === 'weak_password' ? { failures: (r?.failures ?? []).map(String) } : {}),
    };
  }

  /**
   * The requester's address for the per-source limit. ⚠️ From the connection and the proxy header the
   * edge already trusts for the deny-list (W32) — never from the body.
   */
  private sourceRef(req: Request): string {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    return forwarded || req.ip || req.socket?.remoteAddress || '';
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
      // The repair path (roadmap 5.10). Idempotent, never throws: for everyone who already has a
      // profile this is one cheap read, and for the people who registered before it existed it is the
      // only thing that gives them one.
      await this.profile.fromAccessToken(pair.accessToken);
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

  /**
   * Convenience — the current identity from the validated session (protected by the guard).
   *
   * ── Feature 029: it now also returns the caller's EFFECTIVE PERMISSION KEYS ──────────────────
   * The shell must render only the modules a person may use (FR-020), and the Inbox must not show an
   * admin-only control to an agent (FR-018). Both need the resolved key set, and `roles` alone cannot
   * answer either: a role is a bundle whose contents live server-side and change without the client.
   *
   * ⚠️ `@ResolvesPermissions()` is required, not decoration. The guard fills `req.effective` **only**
   * for routes carrying permission metadata; without it this route would answer `[]` for everybody —
   * an empty set that looks exactly like "this person may do nothing", and the shell would render an
   * empty rail for an admin. That is feature 016's live defect in a new place, which is why the
   * decorator exists as an explicit, nameable position.
   *
   * ⛔ **This is convenience for rendering, never enforcement.** Every route still checks its own key
   * server-side. A client that lies to itself about this list gets refusals, not access.
   */
  @Get('me')
  @ResolvesPermissions()
  me(@Req() req: Request & { claims?: RequestClaims; effective?: EffectivePermissions }) {
    const claims = req.claims;
    return {
      userId: claims?.userId,
      accountId: claims?.accountId,
      roles: claims?.roles ?? [],
      permissionKeys: req.effective?.permissionKeys ?? [],
    };
  }
}
