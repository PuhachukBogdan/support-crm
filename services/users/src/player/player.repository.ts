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

  /**
   * Which HUMAN this record belongs to — `null` when it is not linked to any other (feature 022,
   * roadmap 4.13).
   *
   * ── Why this direction did not exist ─────────────────────────────────────────────────────────
   * Feature 020 stored the link and exposed only `person → members`. Every card, though, is opened on a
   * brand-scoped PLAYER record, so the person-level reads 020 declared could not be addressed: the caller
   * had no way to obtain the identifier they require. A stored link unreachable from the side the product
   * reads from is the same defect as an rpc nothing serves, one layer down.
   *
   * ── No new index ────────────────────────────────────────────────────────────────────────────
   * Served exactly by `PersonMember.@@unique([account_id, brand_id, player_id])` (feature 020). That
   * constraint is also why a record can belong to at most ONE person — a database guarantee, not a service
   * convention, which is why this returns a value rather than picking from a list.
   *
   * `null` is deliberately not "a person of one". A caller must be able to tell "linked to nobody" from
   * "linked to a person that currently has one member" — the second is a real state an unlink can leave.
   */
  async personIdOf(id: PlayerIdentity): Promise<string | null> {
    // ⚠️ Takes a `PlayerIdentity`, not three strings — and that is not style. The first draft of this method
    // was `personIdOf(accountId, brandId, playerId)`, which `identity.structure.spec.ts` flagged: three
    // parameters of the same type in a row can be passed in the wrong order and nothing notices, which is
    // precisely the class of mistake feature 020 introduced this type to make impossible. The guard was
    // right about the code, not merely about the pattern.
    const rows = (await this.prisma.forAccount(id.accountId).personMember.findMany({
      where: { brand_id: id.brandId, player_id: id.playerId },
      select: { person_id: true, player_id: true },
      take: 1,
    })) as Array<{ person_id: string }>;
    return rows[0]?.person_id ?? null;
  }

  /**
   * The same answer for a whole PAGE, in ONE query.
   *
   * `ListPlayersByBrand` returns a page of records, and one lookup per row would be a textbook N+1
   * (Principle VII) — the kind that surfaces as a slow card only once a brand has thousands of customers.
   * Returns a map keyed by `player_id`; an absent key means that record is linked to nobody.
   *
   * Takes the brand once plus a LIST, rather than a list of identities: a page is by definition one brand's
   * customers, so repeating the brand per row would invite two rows in one page to disagree about it.
   */
  async personIdsFor(
    accountId: string,
    brandId: string,
    playerIds: string[],
  ): Promise<Map<string, string>> {
    // An empty page asks nothing: `player_id: { in: [] }` is a round trip to learn what we already know.
    if (playerIds.length === 0) return new Map();
    const rows = (await this.prisma.forAccount(accountId).personMember.findMany({
      where: { brand_id: brandId, player_id: { in: playerIds } },
      select: { person_id: true, player_id: true },
    })) as Array<{ person_id: string; player_id: string }>;
    return new Map(rows.map((r) => [r.player_id, r.person_id]));
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
