import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { costOfChannel, type ChannelCost } from './capacity';

/**
 * The ONE ordered backlog (feature 031, roadmap 4.20 / ADR 0042 §1/§2).
 *
 * ── What was here before ────────────────────────────────────────────────────────────────────────
 * Nothing. The router answered `NO_OPERATOR_AVAILABLE` and, in its own words, *"the conversation stays
 * as it was"* — no record that the work was waiting, no order, and no retry. Over-capacity work simply
 * sat unowned until a person noticed, which is the failure a queue exists to prevent.
 *
 * ── The order, and the one place it is allowed to bend ──────────────────────────────────────────
 * `(backlog_at ASC, id ASC)`. The tie-break on `id` is what makes it stable — the same keyset idiom the
 * inbox list uses, for the same reason.
 *
 * ⭐ **The drain takes the first item the freed capacity can actually SERVE, not strictly the head**
 * (research R5). A strict head-of-line over one sequence starves everything behind an item nobody can
 * take: a chat at the head with every chat-capable agent full blocks an email three people could handle,
 * and it reads as *"the queue is stuck"* rather than as a bug.
 *
 * ⚠️ **Skipping never rewrites `backlog_at`.** That is precisely what keeps the skipped item's place —
 * rewriting it would send a conversation to the back of the queue for the crime of being unservable for a
 * moment, which is how something gets overtaken indefinitely. FR-008 is satisfied by the absence of that
 * write, not by an ordering rule.
 *
 * ── Leaving the backlog ────────────────────────────────────────────────────────────────────────
 * `backlog_at` is cleared whenever the conversation gets an owner, whoever gave it one. A person
 * assigning a queued conversation therefore removes it from the queue as a side effect of assigning it,
 * and FR-010 ("never assigned twice by a drain") holds because the drain only ever considers rows that
 * are still both queued AND unowned — asserted in the claim itself, not checked beforehand.
 */

/** One waiting conversation, as far as the drain is concerned. */
export interface BacklogItem {
  id: string;
  channel: string | null;
  brand_id: string;
  /** The desk it was routed to, so the drain resolves the SAME pool the router used. */
  routed_group_id: string | null;
  backlog_at: Date;
}

@Injectable()
export class BacklogRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Record that a conversation is waiting for capacity.
   *
   * ⚠️ **Idempotent, and the first instant WINS.** `backlog_at` is set only when it is null, so a router
   * that tries the same conversation three times does not push it to the back of its own queue. An
   * unconditional write would make a retry a demotion — and retries are exactly what a full desk produces.
   */
  async enqueue(accountId: string, conversationId: string, at: Date): Promise<void> {
    await this.prisma.forAccount(accountId).conversation.updateMany({
      where: { id: conversationId, backlog_at: null, assignee_operator_id: null },
      data: { backlog_at: at },
    });
  }

  /** Waiting conversations, oldest first. Bounded: a drain does bounded work per freed unit. */
  async waiting(accountId: string, limit: number): Promise<BacklogItem[]> {
    return (await this.prisma.forAccount(accountId).conversation.findMany({
      where: { backlog_at: { not: null }, assignee_operator_id: null },
      // The stable order. `id` is the tie-break, without which two rows enqueued in the same millisecond
      // could swap places between drains and one of them could be passed over for ever.
      orderBy: [{ backlog_at: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, channel: true, brand_id: true, routed_group_id: true, backlog_at: true },
    })) as BacklogItem[];
  }

  /**
   * Leave the backlog. Called when the conversation gains an owner by ANY route.
   *
   * ⓘ Not conditional on being queued: clearing a null is free, and making the caller check first would
   * add a read to every assignment for the benefit of the rare case.
   */
  async dequeue(accountId: string, conversationId: string): Promise<void> {
    await this.prisma.forAccount(accountId).conversation.updateMany({
      where: { id: conversationId },
      data: { backlog_at: null },
    });
  }
}

/**
 * The first waiting item this freed capacity can serve.
 *
 * Pure, so the skip rule can be tested without a database — and the skip rule is the one place this
 * feature deviates from strict FIFO, so it earns its own assertions.
 *
 * @param canServe answers whether a channel fits the capacity that just freed.
 * @returns the item to assign, and the items passed over — which the caller must NOT touch, because
 *          leaving them alone is what preserves their place.
 */
export function firstServable(
  waiting: readonly BacklogItem[],
  canServe: (channel: string | null) => boolean,
): { pick: BacklogItem | null; skipped: BacklogItem[] } {
  const skipped: BacklogItem[] = [];
  for (const item of waiting) {
    if (canServe(item.channel)) return { pick: item, skipped };
    skipped.push(item);
  }
  return { pick: null, skipped };
}

/**
 * Can this channel be served by an agent who has `free` units, one of which just came back?
 *
 * ⚠️ An exclusive channel needs the agent entirely free, which is why this asks for `held` rather than
 * only a number: "four units free" and "holding nothing" are different facts, and a voice call needs the
 * second one.
 */
export function servesChannel(
  channel: string | null,
  freeUnits: number,
  holdsNothing: boolean,
  costs?: Readonly<Record<string, ChannelCost>>,
): boolean {
  const cost = costOfChannel(channel, costs);
  if (cost === 'exclusive') return holdsNothing;
  return cost <= freeUnits;
}
