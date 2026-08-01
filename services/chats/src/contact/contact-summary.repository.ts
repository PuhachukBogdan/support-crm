import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ContactGroupRow } from './contact-summary.fold';

/**
 * The contact-summary read (feature 022, roadmap 4.13) — **one grouped query, no message rows.**
 *
 * ── Why it reads no messages ─────────────────────────────────────────────────────────────────────
 * The facts live on `Conversation` (`last_inbound_at` / `last_outbound_at`), maintained inside the
 * message write's own transaction. So the whole summary is one `groupBy` over the conversations the
 * customer already owns, served by the existing `(account_id, player_id)` index. Aggregating over
 * `Message` instead would visit every message of the customer's entire history — nothing indexes
 * `author_type` — on the critical path of every card open (research R1).
 *
 * ── Why grouped by BOTH dimensions ──────────────────────────────────────────────────────────────
 * `['channel', 'status']` answers three questions with one round trip: the channel rollup, the status
 * breakdown, and the totals. Grouping by one and counting the other would be a second query, and two
 * queries can disagree about the same customer.
 *
 * Account isolation is the scoped client's (`forAccount`, Principle I) — including on `groupBy`, which
 * the extension covers. Brand takes no part in authorization (ADR 0038): it is identity here, and the
 * person-level read narrows by an explicit member list, never by a permitted-brand set.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */

/** One `(brand, player)` pair — the only thing that identifies a customer record (feature 020). */
export interface PlayerIdentity {
  brandId: string;
  playerId: string;
}

/** Prisma's grouped row for this query, before the fold maps it. */
interface GroupedRow {
  channel: string | null;
  status: string;
  _count: { _all: number };
  _max: { last_inbound_at: Date | null; last_outbound_at: Date | null };
}

@Injectable()
export class ContactSummaryRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** ONE brand's player — the triple `(account_id, brand_id, player_id)` (feature 020 / roadmap 5.2). */
  async groupsForPlayer(
    accountId: string,
    identity: PlayerIdentity,
  ): Promise<ContactGroupRow[]> {
    return this.groups(accountId, {
      brand_id: identity.brandId,
      player_id: identity.playerId,
    });
  }

  /**
   * Every conversation of a person's EXPLICITLY LINKED members, in one query.
   *
   * `OR` over the member pairs, not one query per member: all conversations live in one database, so the
   * union is a single indexed read (research R6). The k-way merge feature 015 uses for the audit log
   * exists because those rows sit in three separate databases — copying that shape here would add a
   * merge and a partial-failure mode to a problem that has neither.
   *
   * An EMPTY member list must not become an unfiltered query. `OR: []` matches nothing in Prisma, but
   * relying on that is one refactor away from returning the whole account, so the caller is short-
   * circuited explicitly.
   */
  async groupsForMembers(
    accountId: string,
    members: PlayerIdentity[],
  ): Promise<ContactGroupRow[]> {
    if (members.length === 0) return [];
    return this.groups(accountId, {
      OR: members.map((m) => ({ brand_id: m.brandId, player_id: m.playerId })),
    });
  }

  private async groups(
    accountId: string,
    where: Record<string, unknown>,
  ): Promise<ContactGroupRow[]> {
    const rows = (await this.prisma.forAccount(accountId).conversation.groupBy({
      by: ['channel', 'status'],
      where,
      _count: { _all: true },
      _max: { last_inbound_at: true, last_outbound_at: true },
    } as never)) as unknown as GroupedRow[];

    return rows.map((r) => ({
      channel: r.channel,
      status: r.status,
      conversationCount: r._count._all,
      lastInboundAt: r._max.last_inbound_at,
      lastOutboundAt: r._max.last_outbound_at,
    }));
  }
}
