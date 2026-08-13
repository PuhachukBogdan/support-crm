/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.11) — wire types for the security-posture page.
 *
 * Shapes mirror `specs/039-handover-bans-posture/contracts/api.md` §A3, restated here for the same
 * reason every other screen restates them: `web/` takes no build dependency on the services.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **`severity`, `kind` and `state` are typed as `string` ON THE WIRE, on purpose.**
 *
 * The temptation is to declare them as the three closed unions the contract names, and it is the
 * wrong move on this page specifically. A fact is extensible by adding a row in a SERVICE's registry
 * (FR-023) — including, one day, a row with a word this build has never seen. With closed unions the
 * natural handling of an unrecognised word is a fallback, and every fallback that reads as «fine» is
 * the exact failure this page exists to prevent: **a protection nobody could classify must never
 * render as a protection that passed.**
 *
 * So the wire is honest about what it is (text somebody else chose), and the two functions below are
 * the only place that decides what an unrecognised word means — always in the cautious direction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SecurityFactWire {
  /** Opaque to this screen. It groups and orders; it never branches on a key (FR-023). */
  key: string;
  label: string;
  /** `critical` | `recommended` | `informational` — or something this build does not know. */
  severity: string;
  /** `read` | `built_in` — where the value came from, which is half of what this page says. */
  kind: string;
  /** `ok` | `attention` | `unknown` — or something this build does not know. */
  state: string;
  /** Already rendered by the owning service. The screen formats nothing it does not understand. */
  value: string;
  note?: string;
}

export interface SecurityPostureWire {
  facts: SecurityFactWire[];
  generatedAt: string;
}

/** How a fact is read on the page. `unknown` is the cautious end, and everything strange lands there. */
export type FactState = 'ok' | 'attention' | 'unknown';

/** Where a fact's value came from. `unclear` is what an unrecognised `kind` becomes. */
export type FactOrigin = 'read' | 'built_in' | 'unclear';

/**
 * ⭐ The one-way door: only the exact word `ok` reads as a passing check.
 *
 * Anything else — an unreachable service (`unknown`), a value worth a look (`attention`), or a word
 * from a newer service this build has never seen — is not passing, and an unrecognised word becomes
 * `unknown` rather than being dropped or defaulted to `ok`. «A missing protection and an unreachable
 * service must not look alike», and neither may look like a protection that was verified.
 */
export function factState(state: string): FactState {
  if (state === 'ok' || state === 'attention') return state;
  return 'unknown';
}

/**
 * ⚠️ `built_in` and `read` are the only two claims this page is willing to make about a value's
 * origin. An unrecognised `kind` becomes `unclear` — never «read», which would assert that a number
 * came from the database when nothing here knows that it did.
 */
export function factOrigin(kind: string): FactOrigin {
  if (kind === 'built_in' || kind === 'read') return kind;
  return 'unclear';
}

/** Most attention first. The order is the page's own; the contract leaves severity to us to define. */
export const SEVERITY_ORDER = ['critical', 'recommended', 'informational'] as const;

export interface FactGroup {
  severity: string;
  /** `false` = a severity this build does not know. It is shown FIRST and labelled as such. */
  known: boolean;
  facts: SecurityFactWire[];
}

/**
 * Group the facts by severity, most serious first.
 *
 * ⭐ A fact whose severity this build does not recognise is **not dropped and not demoted**: it is
 * collected into its own group ahead of the critical ones. Dropping it would make a partial view look
 * like a complete one — the same defect as omitting an unreachable service's facts, one layer up.
 */
export function groupBySeverity(facts: readonly SecurityFactWire[]): FactGroup[] {
  const known = new Set<string>(SEVERITY_ORDER);
  const unrecognised = facts.filter((f) => !known.has(f.severity));

  const groups: FactGroup[] = [];
  if (unrecognised.length > 0) {
    groups.push({ severity: 'unrecognised', known: false, facts: unrecognised });
  }
  for (const severity of SEVERITY_ORDER) {
    const inGroup = facts.filter((f) => f.severity === severity);
    if (inGroup.length > 0) groups.push({ severity, known: true, facts: inGroup });
  }
  return groups;
}
