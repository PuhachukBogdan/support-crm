import { Injectable, Inject } from '@nestjs/common';
import type { Cursor } from '@crm/common';
import { PrismaService } from '../prisma.service';
import { identityWhere, type PlayerIdentity } from './player.identity';

/**
 * Read path for the Player entity (feature 006 US3, roadmap 2.7).
 *
 * ⚠️ **Keyed by the TRIPLE `(account_id, brand_id, player_id)` since feature 020** — never by the
 * platform id alone. GR8's `player_id` is unique only within a brand, so the same value under two
 * brands is two different people; the old single-key read returned one row for both of them. Every
 * method here takes a `PlayerIdentity`, which cannot be constructed from a platform id on its own —
 * that is what turns "we forgot the brand here" from a wrong answer into a compile error.
 *
 * The brand-union `include` is gone with the edge: one row IS one brand's player. A human spanning
 * brands is a `Person` (feature 020), asserted on a matching email or phone, never on id equality.
 *
 * Feature 007: reads run under the account-scoped client (`forAccount`), so a player is confined to
 * the caller's account (Principle I). The account now also leads the primary key, so a collision
 * across accounts is refused by the database rather than only filtered by the query.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata, so the DI token
 * must be explicit (Phase-1 gotcha).
 */
@Injectable()
export class PlayerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Account-scoped read by the full identity; null when unknown in this account and brand. */
  getPlayer(id: PlayerIdentity) {
    return this.prisma.forAccount(id.accountId).player.findUnique({
      where: identityWhere(id),
    });
  }

  /**
   * One keyset page of a brand's players (feature 018, roadmap 5.1 — research R5).
   *
   * ── The filter is now a plain predicate, not a relation ──────────────────────────────────────
   * It used to reach through the `PlayerBrand` edge (`brands: { some: { brand_id } }`) because brand
   * membership lived there. Feature 020 put `brand_id` in the key, so the edge is gone and this is a
   * direct column comparison: filter, sort and tie-break now happen on one table, served by one index
   * `(account_id, brand_id, created_at, player_id)`. Fewer moving parts and one hop less.
   *
   * ── The tie-break is not decoration ──────────────────────────────────────────────────────────
   * `player_id` breaks a `created_at` tie. Without it, two records created in the same instant sit on
   * a page boundary in an order the database is free to change between queries, and one is silently
   * skipped while the other repeats — the lesson feature 015 recorded for its own trail.
   *
   * ── `player_id` alone would be the wrong cursor ──────────────────────────────────────────────
   * It is a DOMAIN key supplied from outside, so its ordering is arbitrary and unstable as a page
   * boundary. `created_at` is ours and monotonic. Since feature 020 it is not even unique on its own,
   * which is one more reason it could never have been the cursor.
   *
   * Takes `limit + 1` to learn whether a further page exists — no `COUNT`, no offset (Principle VII).
   */
  async listByBrand(
    accountId: string,
    brandId: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: PlayerRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = { brand_id: brandId };
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
    })) as PlayerRow[];

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

/**
 * A player row as both reads return it.
 *
 * Renamed from `PlayerWithBrands` by feature 020: there are no brand edges to carry, and the old
 * name asserted the very thing that was wrong — that one row spans brands. `brand_id` is a column.
 */
export type PlayerRow = {
  player_id: string;
  brand_id: string;
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
};
