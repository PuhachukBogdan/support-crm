import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECTED_PLAYER_FIELDS } from './wire';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const USERS_PROTO = join(ROOT, 'libs', 'proto', 'crm', 'users', 'v1', 'users.proto');

/**
 * Feature 022 (roadmap 4.13) — **the edge's allow-list must cover the contract.**
 *
 * ── Why this test exists, and why it is not optional ────────────────────────────────────────────
 * `toPlayerResponse` projects a decoded `Player` through an EXPLICIT field list, deliberately: a spread
 * would forward whatever a future message gains, and the one field kept out of that contract is a
 * customer PII snapshot. That is the right design — an allow-list at a boundary that hands out contact
 * data.
 *
 * But an allow-list nobody is obliged to update is a silent filter, and this one has now dropped a newly
 * added field **twice**, both times found only by a live run:
 *
 *   · feature 020's `brandId` — the record's own brand, missing from the card;
 *   · feature 022's `person_id` — which human the record belongs to, so the person-level reads were
 *     unaddressable from the surface that needs them.
 *
 * Both times the contract was right, the owning service was right, and the wire between them was not —
 * the fifth occurrence of that class in this product (4.9, 5.1, 5.2, 5.6, and here). Twice is a pattern,
 * so the obligation is now mechanical: add a field to the contract and this test tells you where to add
 * it at the edge.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
 * It does not require the edge to expose everything. `gr8_snapshot` is excluded BY NAME with its reason,
 * and the exclusion is asserted to still be excluded — so the escape hatch cannot quietly grow.
 */

/** Field names declared in a proto message, in declaration order. */
function protoFields(proto: string, message: string): string[] {
  const body = new RegExp(String.raw`message\s+${message}\s*\{([\s\S]*?)\n\}`).exec(proto)?.[1] ?? '';
  return [...body.matchAll(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => m[1]!);
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Deliberately NOT projected, each with the reason it must stay out.
 *
 * `gr8_snapshot` is the opaque GR8 payload: it carries contact PII (surname / phone / email / address),
 * it is `masked_pii` in the tier map, and roadmap R3 records that two mechanisms currently DISAGREE about
 * whether an AM may see customer PII. Until that is resolved, no PII-tier field may reach the wire at all
 * — which is why the contract does not declare it and this list names it anyway: if it is ever declared,
 * this test is where the decision has to be made rather than defaulted.
 */
const DELIBERATELY_ABSENT = ['gr8_snapshot'];

describe('the players edge projects every field the contract declares', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');
  const declared = protoFields(proto, 'Player');

  it('the scan found the contract and a plausible field count (nothing below can pass vacuously)', () => {
    expect(declared.length).toBeGreaterThan(8);
    expect(declared).toContain('player_id');
    expect(PROJECTED_PLAYER_FIELDS.length).toBeGreaterThan(8);
  });

  it('every declared field is projected, unless it is deliberately absent', () => {
    // The assertion that would have caught `brandId` in feature 020 and `personId` in feature 022 — both
    // of which cost a live run to find.
    const projected = new Set(PROJECTED_PLAYER_FIELDS.map(snake));
    const missing = declared.filter((f) => !projected.has(f) && !DELIBERATELY_ABSENT.includes(f));
    expect(missing).toEqual([]);
  });

  it('nothing is projected that the contract does not declare (a stale entry filters nothing)', () => {
    // The other direction: a renamed proto field leaving a dead entry behind would read as "still exposed"
    // while exposing nothing — the same disease as a permanently-false authorization branch.
    const declaredSet = new Set(declared);
    const stale = PROJECTED_PLAYER_FIELDS.filter((f) => !declaredSet.has(snake(f)));
    expect(stale).toEqual([]);
  });

  it('the PII-tier snapshot is still absent from the contract AND from the projection', () => {
    for (const name of DELIBERATELY_ABSENT) {
      expect({ name, declared: declared.includes(name) }).toEqual({ name, declared: false });
      expect(PROJECTED_PLAYER_FIELDS.map(snake)).not.toContain(name);
    }
  });

  it('person_id specifically is projected — the field this test was written for', () => {
    expect(PROJECTED_PLAYER_FIELDS).toContain('personId');
    expect(declared).toContain('person_id');
  });

  it('the field-name conversion is exercised on both shapes (so the comparison is real)', () => {
    // A broken converter would make every comparison above trivially pass or trivially fail.
    expect(snake('customAttributesJson')).toBe('custom_attributes_json');
    expect(snake('personId')).toBe('person_id');
    expect(snake('vip')).toBe('vip');
  });
});
