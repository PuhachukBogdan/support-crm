import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';

/** Local (DB-free) verification result — mirrors proto TokenClaims, numeric expiry. */
export interface AccessClaims {
  valid: boolean;
  userId: string;
  accountId: string;
  roles: string[];
  /** Unix seconds; 0 when invalid. */
  expiresAt: number;
}

export interface IssuedAccess {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface IssuedRefresh {
  /** Cookie value: `<rowId>.<secret>`; only the hash is stored at rest. */
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * TokenService (feature 009, T015). Owns the cryptographic material of a session:
 *  - argon2id password hashing/verification;
 *  - the short-lived access JWT (HS256, `JWT_SECRET`) — signed here, verified LOCALLY at the
 *    gateway on every request (Principle VII, no DB hit);
 *  - issuing the rotating refresh token (opaque secret; only its argon2 hash is persisted).
 *
 * account_id is embedded in the access claims and in the RefreshToken row, so a token minted
 * for one account is structurally bound to it (Principle I / research R7). Rotation/revocation
 * of the refresh token is added in US3.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private argonOpts() {
    return {
      type: argon2.argon2id,
      memoryCost: this.cfg.ARGON2_MEMORY_COST,
      timeCost: this.cfg.ARGON2_TIME_COST,
    } as const;
  }

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, this.argonOpts());
  }

  /** Constant-ish verify; never throws (a malformed hash is simply a non-match). */
  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Sign an access JWT. Expiry is real-time (`expiresIn`), verified the same way at the edge. */
  signAccessToken(claims: { userId: string; accountId: string; roles: string[] }): IssuedAccess {
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAt = nowSec + this.cfg.ACCESS_TTL;
    const token = this.jwt.sign(
      { sub: claims.userId, account_id: claims.accountId, roles: claims.roles },
      { secret: this.cfg.JWT_SECRET, expiresIn: this.cfg.ACCESS_TTL },
    );
    return { token, expiresAt };
  }

  /** Local verify → claims. Invalid/expired/tampered tokens fail closed (`valid: false`). */
  verifyAccessToken(token: string): AccessClaims {
    try {
      const p = this.jwt.verify<{
        sub: string;
        account_id: string;
        roles?: string[];
        exp: number;
      }>(token, { secret: this.cfg.JWT_SECRET });
      return {
        valid: true,
        userId: p.sub,
        accountId: p.account_id,
        roles: p.roles ?? [],
        expiresAt: p.exp,
      };
    } catch {
      return { valid: false, userId: '', accountId: '', roles: [], expiresAt: 0 };
    }
  }

  /**
   * Issue a rotating refresh token. The opaque secret leaves only in the httpOnly cookie
   * (`<id>.<secret>`); at rest we keep its argon2 hash. Lifetime is fixed at issue (no sliding).
   */
  async issueRefresh(
    userId: string,
    accountId: string,
    rememberMe: boolean,
    rotatedFrom?: string,
  ): Promise<IssuedRefresh> {
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret, this.argonOpts());
    const ttl = rememberMe ? this.cfg.REMEMBER_TTL : this.cfg.SESSION_TTL;
    const expiresAt = new Date(this.clock.now().getTime() + ttl * 1000);
    const row = await this.prisma.refreshToken.create({
      data: {
        account_id: accountId,
        user_id: userId,
        token_hash: tokenHash,
        remember_me: rememberMe,
        expires_at: expiresAt,
        rotated_from: rotatedFrom ?? null,
      },
    });
    return {
      refreshToken: `${row.id}.${secret}`,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    };
  }
}
