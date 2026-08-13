import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { TokenService } from './token.service';
import type { IssuedTokenPair } from './login.service';

/**
 * RefreshService (feature 009, US3 / T026). Owns the rotating session lifecycle:
 *  - `refresh` — verify the presented refresh secret, ROTATE it (revoke the old, issue a new
 *    linked by `rotated_from`), mint a fresh access token; the session CLASS (1d vs 7d) is
 *    preserved from the stored token (authoritative — a client cannot silently upgrade it).
 *  - **Reuse detection** — presenting an already-revoked/rotated token means a leak; the whole
 *    live token chain for that user is revoked (fail-closed) and no new pair is issued.
 *  - `logout` — revoke the presented refresh token.
 *
 * All expiry is evaluated server-side against the injectable clock (no client clock trust).
 */
@Injectable()
export class RefreshService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  async refresh(rawRefresh: string): Promise<IssuedTokenPair | null> {
    const parsed = this.parse(rawRefresh);
    if (!parsed) return null;

    const row = await this.prisma.refreshToken.findUnique({ where: { id: parsed.id } });
    if (!row) return null;

    // Expired (server-side clock; a wrong client clock cannot extend it).
    if (row.expires_at.getTime() <= this.clock.now().getTime()) return null;

    // Reuse of an already-revoked/rotated token ⇒ probable theft: revoke the whole live chain.
    if (row.revoked_at) {
      await this.revokeUserChain(row.user_id);
      return null;
    }

    const ok = await argon2.verify(row.token_hash, parsed.secret).catch(() => false);
    if (!ok) return null;

    // Rotate: revoke the presented token, then issue a successor linked to it.
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revoked_at: this.clock.now() },
    });

    const roles = await this.loadRoles(row.user_id);
    const access = this.tokens.signAccessToken({
      userId: row.user_id,
      accountId: row.account_id,
      roles,
    });
    // Preserve the original session class (no silent upgrade to "remember me").
    const refresh = await this.tokens.issueRefresh(
      row.user_id,
      row.account_id,
      row.remember_me,
      row.id,
    );

    return {
      accessToken: access.token,
      refreshToken: refresh.refreshToken,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  async logout(rawRefresh: string): Promise<boolean> {
    const parsed = this.parse(rawRefresh);
    if (!parsed) return false;
    const row = await this.prisma.refreshToken.findUnique({ where: { id: parsed.id } });
    if (!row || row.revoked_at) return false;
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revoked_at: this.clock.now() },
    });
    return true;
  }

  /**
   * Revoke EVERY live refresh token of one person, and answer how many died.
   *
   * ⭐ W31 / 038 (ADR 0043 §3): promoted from private. It has always done the right thing and had
   * exactly one caller — the reuse detector one screen up, which reads a stolen token as a reason to
   * end every session that person has. Offboarding is the same statement with a different trigger:
   * this account stops being a way in, now.
   *
   * ⚠️ What this DOES and does not buy, stated because the difference is the whole honesty of the
   * feature: the refresh chain dies here, so no session can renew itself. An ACCESS token already in
   * a browser keeps working until it expires (15 minutes), except on routes that check a permission
   * — those consult the effective-permission cache, which the deactivation path drops. Making it
   * instant everywhere means a per-request cross-service hop, a product-wide decision this block has
   * no mandate to take (research D4). The bound is stated in the spec rather than implied to be zero.
   */
  async revokeUserChain(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: this.clock.now() },
    });
    return result.count ?? 0;
  }

  private parse(raw: string): { id: string; secret: string } | null {
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
  }

  private async loadRoles(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    return rows.map((r) => r.role.key);
  }
}
