/**
 * Fold the ONE grouped query into what the player card shows (feature 022, roadmap 4.13). Pure.
 *
 * ── The shape of the read, and why it is one query ───────────────────────────────────────────────
 * `conversation.groupBy({ by: ['channel','status'], _count, _max: { last_inbound_at, last_outbound_at } })`
 * over the conversations of one player — or of every linked member of one person. Everything the card
 * needs is arithmetic on that single result set (research R4):
 *
 *   • the overall maxima            → max across all groups
 *   • the per-channel rollup        → collapse the status dimension
 *   • the per-status counts         → collapse the channel dimension
 *   • the total conversation count  → sum
 *
 * That is what makes FR-010 ("the per-channel counts sum to the total") an **identity of one result
 * set** rather than an agreement between two queries. Two queries can disagree; arithmetic cannot.
 *
 * ── Why `lastContactAt` is returned rather than left to the caller ──────────────────────────────
 * It is derived — the later of the two — and derived once, here. Two callers deriving it would
 * eventually disagree about which side wins on a tie, and the disagreement would surface as a card and
 * a report describing the same customer differently.
 *
 * ── Why the unrecorded channel is a BOOLEAN and not a name ──────────────────────────────────────
 * `Conversation.channel` is nullable, and `''` is already how a null channel renders elsewhere in this
 * product — so an empty string cannot distinguish "no channel recorded" from "a channel named ''". A
 * sentinel like `"unknown"` would collide with a future channel of that name. A separate flag cannot
 * collide with any value Phase 6 chooses.
 */

/** One row of the grouped query, already mapped out of Prisma's `_count` / `_max` shape. */
export interface ContactGroupRow {
  /** `null` = the conversation's channel was never recorded (nullable until Phase 6 fills it in). */
  channel: string | null;
  status: string;
  conversationCount: number;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
}

export interface ChannelContactEntry {
  /** The recorded channel, verbatim. Empty when `channelUnrecorded`. */
  channel: string;
  channelUnrecorded: boolean;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  conversationCount: number;
}

export interface StatusCount {
  status: string;
  conversationCount: number;
}

export interface ContactSummaryFacts {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** DERIVED: the later of the two above. `null` = no contact in either direction. */
  lastContactAt: Date | null;
  conversationCount: number;
  countsByStatus: StatusCount[];
  channels: ChannelContactEntry[];
}

/** The later of two optional instants, or `null` when neither happened. */
function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export function foldContactSummary(rows: ContactGroupRow[]): ContactSummaryFacts {
  let lastInboundAt: Date | null = null;
  let lastOutboundAt: Date | null = null;
  let conversationCount = 0;

  const byStatus = new Map<string, number>();
  // Keyed by the channel value with `null` kept distinct from every string, so a conversation with no
  // recorded channel can never land in a group named after a real one.
  const byChannel = new Map<string | null, ChannelContactEntry>();

  for (const r of rows) {
    conversationCount += r.conversationCount;
    lastInboundAt = later(lastInboundAt, r.lastInboundAt);
    lastOutboundAt = later(lastOutboundAt, r.lastOutboundAt);

    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.conversationCount);

    const existing = byChannel.get(r.channel);
    if (existing) {
      existing.conversationCount += r.conversationCount;
      existing.lastInboundAt = later(existing.lastInboundAt, r.lastInboundAt);
      existing.lastOutboundAt = later(existing.lastOutboundAt, r.lastOutboundAt);
    } else {
      byChannel.set(r.channel, {
        channel: r.channel ?? '',
        channelUnrecorded: r.channel === null,
        lastInboundAt: r.lastInboundAt,
        lastOutboundAt: r.lastOutboundAt,
        conversationCount: r.conversationCount,
      });
    }
  }

  return {
    lastInboundAt,
    lastOutboundAt,
    lastContactAt: later(lastInboundAt, lastOutboundAt),
    conversationCount,
    // Sorted, because a card renders a list and an unstable order is a diff nobody asked for. A status
    // with no conversations is ABSENT rather than reported as zero — the card asks "is anything
    // unresolved", and a row of zeros answers a question nobody asked.
    countsByStatus: [...byStatus.entries()]
      .map(([status, count]) => ({ status, conversationCount: count }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    // Named channels first, alphabetically; the unrecorded group last. "The ones we cannot name" belong
    // at the end of the list rather than interleaved by whatever the planner returned.
    channels: [...byChannel.values()].sort((a, b) => {
      if (a.channelUnrecorded !== b.channelUnrecorded) return a.channelUnrecorded ? 1 : -1;
      return a.channel.localeCompare(b.channel);
    }),
  };
}
