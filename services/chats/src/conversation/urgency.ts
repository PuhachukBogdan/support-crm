import { type OrderPart } from './order-parts';

/**
 * The urgency RANK, and the one place a priority becomes a number (feature 031, roadmap 4.19 / ADR 0042 §6,
 * research R10).
 *
 * ── Why a stored rank and not a computed one ────────────────────────────────────────────────────
 * The Inbox needs urgency as **one more declared server order** (FR-019), which means the database has to
 * be able to sort by it. Computing urgency per request would make the list's own ordering a scan over the
 * ~372 K-row history — the B2 concern, and the reason counts here come from aggregates rather than
 * `COUNT(*)`. So the rank is a column with an index.
 *
 * ── ⭐ Why the rank contains NO time, and why that is the whole staleness answer ─────────────────
 * R10's warning: *"a rank must be recomputed when its inputs move, and the inputs include time — so
 * 'urgency' that is only written at creation is wrong within the hour."*
 *
 * The resolution is not a sweep. It is to split the key:
 *
 *   • the part that **only moves when somebody changes it** — the priority word — is stored as a rank;
 *   • the part that **moves by itself** — how long this has been sitting — is read at query time from
 *     `updated_at`, a column that is current by definition.
 *
 * ⇒ There is no state that can be stale. A rank embedding age would need a periodic pass over every open
 * conversation to stay true and would be wrong in between — and wrong invisibly, because a list in a
 * plausible order looks like a list in the right order.
 *
 * ── ⚠️ What this order does NOT claim ───────────────────────────────────────────────────────────
 * It is *priority first, longest-waiting first within a priority*. It is *not* SLA proximity (the clock
 * lives in `sla/`, and a conversation with a near breach and a `low` priority ranks below a fresh `high`
 * one), and it is not a model of anything. The screen's label must stay inside that claim — the same
 * discipline that made 029 call its two orders "Updated" rather than "Last activity".
 */

/**
 * Word → rank. Deliberately **not** derived from `PRIORITIES`' array position: that array's order is a
 * declaration list, and one alphabetisation of it would silently reorder every queue in the product.
 * The numbers are the meaning, written down.
 */
const PRIORITY_RANK: Readonly<Record<string, number>> = {
  low: 1,
  normal: 2,
  high: 3,
};

/**
 * The floor: no priority, or a word nothing in the product understands.
 *
 * ⚠️ **Not the same as `normal`.** The column is free-form by design (feature 012 kept the list *filter*
 * free-form on purpose), so unrecognised values exist, and a large share of rows carry no priority at all.
 * Ranking those as `normal` would promote untriaged work above work somebody deliberately marked `low` —
 * a claim the data does not support. Unranked sorts last and says so.
 */
export const UNRANKED = 0;

export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return UNRANKED;
  return PRIORITY_RANK[priority] ?? UNRANKED;
}

/**
 * ⭐ The **only** sanctioned way to write the priority column: it produces the word and its rank together,
 * so a writer cannot set one and forget the other.
 *
 * A structural guard (`tests/data-model/priority-rank-recomputed-031.spec.ts`) fails when any path writes
 * `priority:` by hand, because that is exactly how a cached rank goes stale — and a stale rank is
 * undetectable from the list it orders.
 *
 * @example db.conversation.updateMany({ where, data: { ...priorityWrite(a.value) } })
 */
export function priorityWrite(priority: string | null | undefined): {
  priority: string | null;
  priority_rank: number;
} {
  return { priority: priority ?? null, priority_rank: priorityRank(priority) };
}

/**
 * The parts of the urgency order, most significant first.
 *
 * ⚠️ `updated_at` **ascending** — oldest first. The other two orders on that column read newest-first; here
 * the longest wait is the more urgent one, which is also what makes this a genuinely different sequence
 * rather than a second name for `updated_desc`.
 */
export function urgencyOrderParts(): readonly OrderPart[] {
  return [
    { column: 'priority_rank', direction: 'desc', type: 'int' },
    { column: 'updated_at', direction: 'asc', type: 'time' },
  ];
}
