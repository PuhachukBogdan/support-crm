import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Where an inbound email belongs (feature 033, roadmap 6.4 — T041, FR-029/FR-030/FR-031).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **A WRONG SPLIT CANNOT BE UNDONE.** Every other defect in this feature has a repair: a duplicate
 * can be hidden, a wrong identity can be re-attached, an unsent reply can be sent. A conversation that
 * arrived as twenty tickets is twenty real tickets with twenty real histories, and nothing anywhere
 * records that they were once one thread. That asymmetry is why this file matches on an identifier we
 * ourselves stored and refuses every form of approximation.
 *
 * **What it deliberately does NOT match on**: the subject line (three customers write "Проблема с
 * выводом" in an afternoon), the sender's address (a player's second question is not a reply to their
 * first), recency ("their last ticket" is a guess wearing a heuristic's clothes). Those are exactly the
 * "nearest guess" FR-031 forbids, and each of them is *usually* right — which is what makes them
 * dangerous. A missed stitch shows up as a new ticket somebody notices. A wrong stitch puts one
 * customer's words into another conversation and looks like it worked.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ThreadMatch {
  conversationId: string;
  /** The status key the matched conversation currently wears — the reopen rule needs it. */
  status: string;
}

@Injectable()
export class ThreadResolver {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The conversation this reply belongs to, or `null` when we hold nothing it refers to.
   *
   * `null` is an ORDINARY answer, not a failure: a first email from a stranger refers to nothing, and so
   * does a reply to a message sent by some other system. The caller creates a ticket in both cases.
   *
   * ⚠️ **Brand-scoped as well as account-scoped.** A match under a different brand is discarded rather
   * than used: brands have separate mailboxes, so a cross-brand thread means either a misconfiguration
   * or a forged header, and both must produce a new ticket instead of moving a conversation into a brand
   * whose agents were never meant to see it (FR-020's rule, applied to threading).
   */
  async resolve(
    accountId: string,
    brandId: string,
    refs: { inReplyTo?: string; references?: readonly string[] },
  ): Promise<ThreadMatch | null> {
    const candidates = candidateIds(refs);
    if (candidates.length === 0) return null;

    // ⚠️ ONE query for all candidates rather than one query each. A long `References` chain on a
    // fifty-message thread would otherwise be fifty round trips on the busiest write path in the
    // product (Principle VII) — and the answer is the same, because the candidates are ordered here
    // and the winner is picked from what came back.
    const rows = (await this.prisma.forAccount(accountId).message.findMany({
      where: { external_id: { in: candidates } },
      select: {
        external_id: true,
        conversation: { select: { id: true, brand_id: true, status: true } },
      },
    })) as Array<{
      external_id: string | null;
      conversation: { id: string; brand_id: string; status: string } | null;
    }>;

    if (rows.length === 0) return null;

    const byId = new Map<string, { id: string; brand_id: string; status: string }>();
    for (const r of rows) {
      // A message whose conversation is gone is not a thread to join. It cannot happen through the
      // cascade, and reading it as "no match" is the safe direction if it ever does.
      if (r.external_id && r.conversation) byId.set(r.external_id, r.conversation);
    }

    // The FIRST candidate that resolves wins — `In-Reply-To` before the `References` chain, and the
    // chain newest-first (the adapter reverses RFC order for exactly this). A reply belongs to the
    // conversation of the message it answers, not to the oldest ancestor it happens to quote.
    for (const id of candidates) {
      const conv = byId.get(id);
      if (!conv) continue;
      if (conv.brand_id !== brandId) continue;
      return { conversationId: conv.id, status: conv.status };
    }

    return null;
  }
}

/**
 * The identifiers to try, in priority order, de-duplicated.
 *
 * ⚠️ Empty strings are dropped rather than queried. `external_id` is NULL on every non-email message
 * and Postgres treats NULLs as distinct, but an empty-string candidate would still match any message
 * that had somehow stored `''` — and the one thing worse than a missed stitch is a stitch onto whatever
 * row happens to hold a blank.
 */
function candidateIds(refs: { inReplyTo?: string; references?: readonly string[] }): string[] {
  const ordered = [refs.inReplyTo ?? '', ...(refs.references ?? [])]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v !== '');
  return [...new Set(ordered)];
}
