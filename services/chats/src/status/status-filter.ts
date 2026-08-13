import { categoryFromWire, LEGACY_STATUS_WIRE_UNSPECIFIED } from '@crm/common';
import type { StatusRepository } from './status.repository';

/**
 * The status FILTER, resolved once for both callers that have one (feature 032, roadmap 4.16).
 *
 * ── Why this is a shared function and not two implementations ─────────────────────────────────────
 * `ListConversations` and `CreateExport` speak one filter vocabulary (FR-027), and the last time that was
 * an intention rather than shared code, the two drifted: feature 017's export edge grew `pending` where
 * the list said `running`, and it was found on a live run, not by a test. `tests/exports/filter-parity.spec.ts`
 * polices the proto; this file is what keeps the DECODING identical.
 *
 * ── Three answers, and the difference between them matters ────────────────────────────────────────
 *   • `undefined` — no status filter. The caller asked about every status.
 *   • a non-empty list — these keys.
 *   • `[]` — "no configured status satisfies the ask" (e.g. the `closed` category, which has no seeded
 *     status). It must produce an EMPTY page, never an unfiltered one. That is the 012 lesson, and it is
 *     why the repository takes a list rather than an optional single value.
 */
export class StatusFilterError extends Error {}

export interface StatusFilterWire {
  /** The DEPRECATED enum field. Present only so it can be refused. */
  status?: string;
  statusKey?: string;
  statusCategory?: string;
  /**
   * W5 (R38): the plural — one rail bucket is a UNION («Ждут» = pending + on_hold), which the singular
   * cannot say. Both fields may arrive; their categories union. Each entry is validated exactly like
   * the singular: an unknown one refuses, because dropping it would widen the query.
   */
  statusCategories?: string[];
}

export async function resolveStatusFilter(
  statuses: StatusRepository,
  accountId: string,
  f: StatusFilterWire,
): Promise<string[] | undefined> {
  /**
   * ⚠️ The legacy enum is REFUSED, not translated.
   *
   * A translation exists (`resolved → solved`, `snoozed → pending`) and it is correct for MIGRATING STORED
   * DATA — but not for a filter. `SNOOZED` would come to mean "every pending conversation", which is a
   * plausible page of the wrong rows: precisely the confidently-wrong-answer shape feature 012 shipped and
   * Track B caught. One error at a boundary with a single caller beats a wrong answer with none.
   */
  if (f.status && f.status !== LEGACY_STATUS_WIRE_UNSPECIFIED) {
    throw new StatusFilterError('status is replaced by status_key / status_category');
  }

  const key = f.statusKey || undefined;

  // The singular and the plural collapse into ONE set of categories before anything is resolved, so
  // there is exactly one code path after this line — two paths for "one category" and "categories"
  // would be the same filter implemented twice, which is how the export vocabulary drifted.
  const named: NonNullable<ReturnType<typeof categoryFromWire>>[] = [];
  const singular = categoryFromWire(f.statusCategory);
  if (singular === null) {
    // A category the closed catalogue does not define. Refused rather than ignored — ignoring it would
    // widen the query to every conversation, the opposite of what the caller asked for.
    throw new StatusFilterError('invalid status_category');
  }
  if (singular) named.push(singular);
  for (const entry of f.statusCategories ?? []) {
    const c = categoryFromWire(entry);
    if (!c) throw new StatusFilterError('invalid status_category');
    if (!named.includes(c)) named.push(c);
  }

  if (!key && named.length === 0) return undefined;

  if (key && !(await statuses.existsKey(accountId, key))) {
    // Includes another account's key, which is tenant isolation answering rather than a validation quirk:
    // a key that exists next door does not exist here.
    throw new StatusFilterError('invalid status_key');
  }

  if (key && named.length === 0) return [key];

  // The UNION of the named categories' keys, deduplicated in catalogue order.
  const ofCategories: string[] = [];
  for (const c of named) {
    for (const k of await statuses.keysOfCategory(accountId, c)) {
      if (!ofCategories.includes(k)) ofCategories.push(k);
    }
  }
  if (!key) return ofCategories;

  // Both: the intersection. A key that is not in the named categories is a contradictory question, and
  // an empty page is its honest answer — refusing would require this code to decide which half the
  // caller "meant", which is a guess.
  return ofCategories.includes(key) ? [key] : [];
}
