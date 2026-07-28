import { Injectable, Inject } from '@nestjs/common';
import type { Cursor } from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * Read path for the Player entity (feature 006 US3, roadmap 2.7). Keyed by the domain
 * `player_id`; includes the brand-union edges so callers get ONE unified player across 1..N
 * brands (ADR 0032 §0.1). The GR8 snapshot is returned verbatim (opaque) — no typing here.
 *
 * Feature 007: the read runs under the account-scoped client (`forAccount`), so the player is
 * confined to the caller's account (Principle I) — while the brand-union is preserved (the
 * player-union brand exception is brand-level, never account-level). The `accountId` is supplied
 * by the caller; until Auth (Phase 3) authenticates it, callers/tests pass it explicitly.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata, so the DI
 * token must be explicit (Phase-1 gotcha).
 */
@Injectable()
export class PlayerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Unified, account-scoped read by domain key; null when the player is unknown in this account. */
  getPlayerById(accountId: string, playerId: string) {
    return this.prisma.forAccount(accountId).player.findUnique({
      where: { player_id: playerId },
      include: { brands: true },
    });
  }

  /**
   * One keyset page of a brand's players (feature 018, roadmap 5.1 — research R5).
   *
   * ── Why the ORDER lives on this table and the FILTER goes through the edge ───────────────────
   * The brand membership is an edge table with no `account_id` of its own — it is scoped through this
   * parent, which is the documented exception in `prisma.scoped-models.ts`. So the filter is a relation
   * predicate (`brands: { some: { brand_id } }`) while the ordering and the cursor stay on `Player`,
   * where the account predicate the isolation extension injects also lands. One index —
   * `(account_id, created_at, player_id)` — therefore serves the filter, the sort and the tie-break at
   * once. Ordering on the edge instead would put the sort on one table and the tie-break on another,
   * and the "exactly once" guarantee would depend on join order.
   *
   * ── The tie-break is not decoration ──────────────────────────────────────────────────────────
   * `player_id` breaks a `created_at` tie. Without it, two records created in the same instant sit on a
   * page boundary in an order the database is free to change between queries, and one of them is silently
   * skipped while the other repeats — the lesson feature 015 recorded for its own trail.
   *
   * ── `player_id` alone would be the wrong cursor ───────────────────────────────────────────────
   * It is a DOMAIN key supplied from outside, so its ordering is arbitrary and unstable as a page
   * boundary. `created_at` is ours and monotonic.
   *
   * Takes `limit + 1` to learn whether a further page exists — no `COUNT`, no offset (Principle VII).
   */
  async listByBrand(
    accountId: string,
    brandId: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: PlayerWithBrands[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = { brands: { some: { brand_id: brandId } } };
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.OR = [
        { created_at: { lt: at } },
        { AND: [{ created_at: at }, { player_id: { lt: cursor.id } }] },
      ];
    }

    const rows = (await this.prisma.forAccount(accountId).player.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { player_id: 'desc' }],
      take: limit + 1,
      include: { brands: true },
    })) as PlayerWithBrands[];

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      rows: kept,
      nextCursor:
        hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.player_id } : null,
    };
  }
}

/** A player row with its brand edges, as both reads return it. */
export type PlayerWithBrands = {
  player_id: string;
  account_id: string;
  vip: boolean;
  segment: string | null;
  am_notes: string | null;
  preferences: unknown;
  portfolio: unknown;
  custom_attributes: unknown;
  gr8_snapshot: unknown;
  gr8_fetched_at: Date | null;
  gr8_stale: boolean;
  created_at: Date;
  updated_at: Date;
  brands: { player_id: string; brand_id: string }[];
};
