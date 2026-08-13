/**
 * Capacity in UNITS (feature 031, roadmap 4.21 / ADR 0042 §3).
 *
 * ── ⚠️⚠️ THIS IS NOT A SECOND CAPACITY GATE, and the distinction is the whole reason for this note ──
 * Capacity **already exists**: `group-pool.ts` counts each candidate's open conversations
 * (`OPEN_STATUSES`) and compares them against `defaultCapacity()`, a flat per-deployment number, and
 * the rotation already refuses an over-capacity operator. Found while wiring T013 — the router's own
 * comment says *"never assigned to an over-capacity operator"*.
 *
 * So this module is deliberately **arithmetic, not a decision**: it is what `group-pool.ts` uses to
 * turn "three conversations" into "three units, one of which is exclusive". There is exactly one place
 * that decides whether somebody has room, and it is still the pool.
 *
 * ⇒ A parallel gate would have been the defect this project keeps catching: two mechanisms that both
 * decide, diverging invisibly until somebody is handed a fifth conversation. Feature 030 was caught by
 * a guard for the same shape one layer up.
 *
 * ── What 4.21 actually ADDS to what was already there ────────────────────────────────────────────
 * The shipped version counts **conversations** against **one flat number**. ADR 0042 §3 asks for
 * **units** (a conversation may cost more than one), **per-channel cost** (voice is exclusive), and a
 * budget **per role × brand** rather than per deployment. That is what lives here.
 *
 * ── What capacity is for ─────────────────────────────────────────────────────────────────────────
 * The router may hand somebody work only while they have room for it. Without this, "push routing"
 * means pushing a fifth live chat at a person already holding four, which is the outcome capacity
 * exists to prevent.
 *
 * ── 🅿 The numbers are PROVISIONAL and are the operator's to confirm ─────────────────────────────
 * The roadmap marks them 🅿: chat/messenger 1 unit with 4 concurrent, voice exclusive. They are
 * **defaults**, not decided values, and T025 moves them into configuration so an administrator can
 * change them without a deploy. Hardening them here would quietly convert a placeholder into a
 * requirement — so this module exposes them as overridable arguments from the start.
 *
 * ── ⭐ Why FR-013 needs no filter here, and why that is worth writing down ───────────────────────
 * FR-013 says portfolio conversations must consume no queue capacity. That holds **by construction**
 * rather than by a predicate: the router only ever considers roles for which `isQueueRole` is true, and
 * that derivation excludes exactly the roles that hold a portfolio (`am`, `shift_am`) — plus the
 * administrative ones. So a caller counted here cannot have portfolio work to exclude.
 *
 * ⚠️ It is stated rather than assumed because the day `isQueueRole` widens, this becomes a real filter
 * and its absence would be silent. `capacity.spec.ts` asserts the coupling.
 *
 * ── This module decides nothing about presence ───────────────────────────────────────────────────
 * Availability is a separate question with a separate owner (feature 025), and `transfers_only` is
 * deliberately handled there: it is **not** available for routed work, while its units are still
 * counted here. A person finishing up holds their work; the queue must not treat their slots as free.
 */

/** Cost of one active conversation, by channel. `null` = EXCLUSIVE: it consumes the whole person. */
export type ChannelCost = number | 'exclusive';

/**
 * 🅿 Provisional per-channel costs. Unknown channels cost one unit — the honest default, because a new
 * channel arriving before anybody prices it is still work, and pricing it at zero would make it free.
 */
export const PROVISIONAL_CHANNEL_COST: Readonly<Record<string, ChannelCost>> = {
  chat: 1,
  messenger: 1,
  email: 1,
  api: 1,
  voice: 'exclusive',
} as const;

/** 🅿 Provisional budget: four concurrent single-unit conversations. */
export const PROVISIONAL_UNIT_BUDGET = 4;

export function costOfChannel(
  channel: string | null | undefined,
  costs: Readonly<Record<string, ChannelCost>> = PROVISIONAL_CHANNEL_COST,
): ChannelCost {
  const key = (channel ?? '').trim().toLowerCase();
  // ⚠️ An absent channel is not free. ~1 in 6 conversations carry none, and pricing them at zero would
  // let a single agent accumulate unbounded work that the budget cannot see.
  if (!key) return 1;
  return costs[key] ?? 1;
}

/** One conversation an agent already holds, as far as capacity is concerned. */
export interface HeldConversation {
  readonly channel?: string | null;
}

/**
 * Units an agent is currently spending.
 *
 * Returns `'exclusive'` when any held conversation is exclusive: such a person has room for nothing
 * else regardless of arithmetic, and collapsing that into a large number would let a big budget
 * override it.
 */
export function unitsUsed(
  held: readonly HeldConversation[],
  costs: Readonly<Record<string, ChannelCost>> = PROVISIONAL_CHANNEL_COST,
): number | 'exclusive' {
  let total = 0;
  for (const c of held) {
    const cost = costOfChannel(c.channel, costs);
    if (cost === 'exclusive') return 'exclusive';
    total += cost;
  }
  return total;
}

/**
 * Has this agent room for one more conversation on `channel`?
 *
 * ⚠️ **Over budget is not an error.** An administrator may lower a budget below what somebody already
 * holds; existing work is never taken away, so the answer is simply "no room" until it drains (spec
 * Edge Cases). That is why this compares against the budget rather than asserting an invariant.
 */
export function hasRoomFor(
  held: readonly HeldConversation[],
  channel: string | null | undefined,
  budget: number = PROVISIONAL_UNIT_BUDGET,
  costs: Readonly<Record<string, ChannelCost>> = PROVISIONAL_CHANNEL_COST,
): boolean {
  const used = unitsUsed(held, costs);
  if (used === 'exclusive') return false;

  const cost = costOfChannel(channel, costs);
  // An exclusive conversation needs the person entirely free — not merely under budget.
  if (cost === 'exclusive') return used === 0 && budget > 0;

  return used + cost <= budget;
}
