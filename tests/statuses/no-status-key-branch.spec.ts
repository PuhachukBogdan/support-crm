import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  SEEDED_STATUSES,
  LEGACY_STATUS_MIGRATION,
  LEGACY_STATUS_WIRE_UNSPECIFIED,
} from '../../libs/common/src';

/**
 * ⭐ T022 (feature 032, roadmap 4.16 — ADR 0040 §1) — **NOTHING BRANCHES ON A STATUS KEY.**
 *
 * ── The claim, and why it needs a scan ───────────────────────────────────────────────────────────
 * The two-level model only pays for itself if the machine reads CATEGORIES. The moment one function says
 * `if (status === 'vip_pending')`, adding a status stops being configuration and becomes a deployment —
 * and the operator's complaint about their live system (*«всё валится в on hold»*) comes back, because
 * every new operational state has to be a word some code already knows.
 *
 * Every other closed catalogue in this product has the same guard, for the same reason: permissions (011),
 * automation triggers (014), audit actions (015), upload purposes (016), export scopes (017). ADR 0040
 * asks for this one by name.
 *
 * ── ⚠️ Two directions, because either alone is satisfiable by a broken product ────────────────────
 *   1. No status KEY appears as a literal in `chats/src`.
 *   2. The RETIRED four-value vocabulary is gone from the code entirely — not deprecated in place.
 *      A mapper left behind is how the old vocabulary grows back: the next feature needing to turn a
 *      status into something finds a function that answers, and the answer is a guess about four values
 *      out of nine.
 *
 * Comments are stripped first. A guard that bans a token from prose gets "fixed" by deleting the
 * explanation of why the token is banned — the same choice `no-cross-service-access.spec.ts` made.
 */
const ROOT = resolve(__dirname, '..', '..');
const CHATS_SRC = join(ROOT, 'services', 'chats', 'src');

/**
 * Files exempt from the KEY scan, each with a reason.
 *
 * ⚠️ This list is the guard's own weak point, so it stays tiny and every entry is a file whose PURPOSE is
 * to name statuses rather than to react to them. A file added here because it was inconvenient would make
 * the scan meaningless — which is why the test below asserts the list is short.
 */
const KEY_SCAN_EXEMPT = [
  // The test fixture that BUILDS a catalogue for other specs; it names keys by definition.
  'status/status.fixture.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so the scan polices behaviour rather than vocabulary. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const rel = (abs: string) => abs.slice(CHATS_SRC.length + 1).split(sep).join('/');

/** Product code only: a spec legitimately names statuses to build a scenario. */
const SOURCES = walk(CHATS_SRC)
  .filter((f) => !f.endsWith('.spec.ts'))
  .map((abs) => ({ path: rel(abs), code: codeOf(abs) }));

describe('the scan sees the service (nothing below can pass by scanning nothing)', () => {
  it('reads a plausible number of chats source files, including the ones that touch status', () => {
    expect(SOURCES.length).toBeGreaterThan(40);
    for (const path of [
      'status/status.repository.ts',
      'status/status-filter.ts',
      'conversation/conversation.repository.ts',
      'conversation/conversation.write.controller.ts',
      'shared/wire.ts',
    ]) {
      expect(SOURCES.map((s) => s.path)).toContain(path);
    }
  });

  it('the predicate fires on a real branch and stays quiet on ordinary code', () => {
    const fires = (code: string) => /['"`]vip_pending['"`]/.test(code);
    expect(fires("if (status === 'vip_pending') return true;")).toBe(true);
    expect(fires('if (isTerminalCategory(category)) return true;')).toBe(false);
  });

  it('the exemption list is SHORT — a long one would make this guard decorative', () => {
    expect(KEY_SCAN_EXEMPT.length).toBeLessThanOrEqual(2);
  });
});

describe('*** no status KEY is a literal in chats product code ***', () => {
  /**
   * The nine keys, minus the three words that are also CATEGORY names (`new`, `open`, `pending`).
   *
   * ⚠️ Excluded for a collision, not for convenience — exactly the reasoning `single-policy-path.spec.ts`
   * records for `open`. A category name legitimately appears in code (the catalogue, the filter, the
   * terminality helper), so scanning for those three reports the model's own vocabulary as a violation,
   * and a scan that cries wolf gets widened until it asserts nothing.
   *
   * The six that remain are unambiguous and sufficient: they are exactly the statuses a branch would want
   * to name, and `in_progress` / `supervisor_review` are the two the operator's workflow turns on.
   */
  const CATEGORY_COLLISIONS = ['new', 'open', 'pending'];
  const DISTINCTIVE_KEYS = SEEDED_STATUSES.map((s) => s.key).filter(
    (k) => !CATEGORY_COLLISIONS.includes(k),
  );

  it('the exclusion is a collision and the remainder is substantial', () => {
    expect(DISTINCTIVE_KEYS).toEqual([
      'vip_pending',
      'in_progress',
      'follow_up',
      'auto_ended_chat',
      'supervisor_review',
      'solved',
    ]);
  });

  it.each(
    SEEDED_STATUSES.map((s) => s.key).filter((k) => !['new', 'open', 'pending'].includes(k)),
  )('no file names the status `%s`', (key) => {
    const pattern = new RegExp(`['"\`]${key}['"\`]`);
    const offenders = SOURCES.filter(
      (s) => !KEY_SCAN_EXEMPT.includes(s.path) && pattern.test(s.code),
    ).map((s) => s.path);
    expect(offenders).toEqual([]);
  });
});

describe('*** the retired four-value vocabulary is GONE, not deprecated in place ***', () => {
  it('no file mentions the two words that were REMAPPED away', () => {
    // `resolved` → `solved`, `snoozed` → `pending` (ADR 0040 §5). A surviving mention would mean a path
    // still writing or matching a value the database can no longer hold — the FK would refuse it, at
    // runtime, on a customer's conversation.
    for (const gone of ['resolved', 'snoozed']) {
      const pattern = new RegExp(`['"\`]${gone}['"\`]`);
      const offenders = SOURCES.filter((s) => pattern.test(s.code)).map((s) => s.path);
      expect({ gone, offenders }).toEqual({ gone, offenders: [] });
    }
  });

  it('no file names a `CONVERSATION_STATUS_*` enum member (the CATEGORY enum is a different token)', () => {
    // ⚠️ The category enum shares the prefix, so the pattern excludes it explicitly rather than by luck.
    const offenders = SOURCES.filter((s) =>
      /CONVERSATION_STATUS_(?!CATEGORY)[A-Z]/.test(s.code),
    ).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('the three legacy mappers are gone from `shared/wire.ts`', () => {
    const wire = SOURCES.find((s) => s.path === 'shared/wire.ts')!;
    for (const dead of ['statusToWire', 'wireToStatus', 'isValidStatusWire', 'DbStatus']) {
      expect(wire.code).not.toContain(dead);
    }
  });

  it('⭐ the ONE place that still knows a retired member is shared code, not the service', () => {
    // `status-filter.ts` must recognise the enum's zero value to tell "no legacy filter" from "a legacy
    // filter to refuse". That token lives in `libs/common` beside the migration maps, which is what lets
    // the assertion above be absolute instead of carrying an exemption somebody would later widen.
    expect(LEGACY_STATUS_WIRE_UNSPECIFIED).toBe('CONVERSATION_STATUS_UNSPECIFIED');
    const filter = SOURCES.find((s) => s.path === 'status/status-filter.ts')!;
    expect(filter.code).toContain('LEGACY_STATUS_WIRE_UNSPECIFIED');
  });

  it('the migration still maps all four shipped values — the record of what became what', () => {
    // The scan above proves the words are gone from the CODE. This proves they are still ACCOUNTED FOR,
    // because "no mention anywhere" would also be true of a migration that silently dropped them.
    expect(Object.keys(LEGACY_STATUS_MIGRATION).sort()).toEqual([
      'open',
      'pending',
      'resolved',
      'snoozed',
    ]);
  });
});
