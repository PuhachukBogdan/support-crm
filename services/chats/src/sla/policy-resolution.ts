/**
 * First-reply SLA target resolution (feature 014, US2 — roadmap 4.7). Pure: no Prisma, no clock.
 *
 * A policy row scopes itself with the `'*'` sentinel rather than NULL, because in Postgres a unique
 * index treats NULLs as **distinct** — NULL scoping would allow two account-level defaults to coexist
 * and make "the target" ambiguous (research R7). The sentinel makes the constraint actually constrain.
 *
 * Precedence, most specific first:
 *   (brand, priority) → (brand, *) → (*, priority) → (*, *)
 *
 * **No policy ⇒ no clock.** The absence of a target is not a zero target: a conversation in an account
 * with no policy is never measured and never breached. Defaulting to something here would silently
 * start breaching every conversation in every account that has not configured an SLA.
 */

export const ANY = '*';

export interface SlaPolicy {
  target_minutes: number;
  scope_priority: string;
  scope_brand_id: string;
}

export interface TargetSubject {
  priority: string | null;
  brandId: string;
}

/** The most specific matching target, or null when nothing applies. */
export function resolveTarget(policies: SlaPolicy[], subject: TargetSubject): number | null {
  const priority = subject.priority ?? null;
  // Brand-before-priority is a deliberate tie-break: a brand is a tenant-visible boundary in a
  // white-label product, so "this brand answers in 5 minutes" should win over "high priority answers
  // in 10" rather than the reverse.
  const candidates: Array<[string, string]> = [];
  if (priority) candidates.push([subject.brandId, priority]);
  candidates.push([subject.brandId, ANY]);
  if (priority) candidates.push([ANY, priority]);
  candidates.push([ANY, ANY]);

  for (const [brand, prio] of candidates) {
    const hit = policies.find((p) => p.scope_brand_id === brand && p.scope_priority === prio);
    if (hit && hit.target_minutes > 0) return hit.target_minutes;
  }
  return null;
}

/** Normalise an inbound scope value: empty ⇒ the sentinel. A literal `'*'` is rejected upstream. */
export function normaliseScope(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v === '' ? ANY : v;
}
