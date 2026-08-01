import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T057 (feature 025, roadmap 5.9 — FR-036/FR-037): **the line between events and aggregates, and the
 * line before surveillance.** Both asserted, because the roadmap requires them not to be crossed
 * "quietly" — and a sentence in a document is exactly what a later feature crosses without noticing.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────────
 * Analytics and WFM are deferred by the operator, TWICE. The line is drawn at **events versus
 * aggregates**: presence transitions are recorded from day one, and WFM later *reads that stream*.
 * Nothing is built twice, nothing is lost while WFM is parked, and no aggregate is built now.
 *
 * So: recording is in scope. Counting, averaging, scoring and charting are not.
 *
 * ── The second line, which is not a performance concern ─────────────────────────────────────────
 * A heartbeat states that a session is alive. It must never state what the person is LOOKING AT.
 * Screen, panel and keystroke telemetry is a separate, undecided employee-surveillance question with
 * its own purpose, retention, access and staff-transparency obligations. The payload allow-list
 * already makes it unexpressible in the history; this guard is the wider net.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen', 'migrations']);

function sources(root: string): string[] {
  const abs = resolve(REPO_ROOT, root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const FILES = sources('services').concat(sources('libs'), sources('web/src'));
const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

/** Words that only appear when somebody is building the deferred half. */
const WFM_VOCABULARY =
  /\b(adherence|occupancy|attendance|shrinkage|activityTimeline|activity_timeline|performanceBoard|performance_board)\b/i;

/** A count/average OVER presence — the aggregate this feature must not build. */
const PRESENCE_AGGREGATE =
  /operatorPresence\s*\.\s*(count|aggregate|groupBy)\s*\(|operatorTransition\s*\.\s*(count|aggregate|groupBy)\s*\(/;

/**
 * Anything that would turn a heartbeat into a report of what somebody is looking at.
 *
 * ⚠️ `screenshot` is deliberately NOT in this list, and the omission is a finding rather than a gap.
 * The word is already taken by a CUSTOMER-facing product concept: U8 specifies that an
 * attachment-only first message gets the subject *"Скриншот — Bonus"*, and the upload sanitiser is
 * tested with screenshot filenames. Banning it would ban the product's own feature — the same
 * collision shape as `personalizeGroup` (024) and `preferences_json` (021), caught this time by the
 * guard's first run instead of by a reader six months later.
 *
 * The terms below are ones that can only mean employee monitoring: they describe an OPERATOR's
 * screen, not a customer's attachment.
 */
const SURVEILLANCE =
  /\b(keystroke|activeWindow|active_window|currentPanel|current_panel|screenActivity|screen_activity|idleInputMs|operatorScreen|operator_screen)\b/i;

describe('⭐ presence records events and builds NO aggregate (FR-036)', () => {
  it('scanned a plausible number of files', () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('the detectors fire on planted input', () => {
    expect(WFM_VOCABULARY.test('const adherence = worked / scheduled;')).toBe(true);
    expect(PRESENCE_AGGREGATE.test('await db.operatorPresence.groupBy({ by: ["state"] })')).toBe(true);
    expect(SURVEILLANCE.test('payload.activeWindow = title;')).toBe(true);
    // `\b…\b` on both sides, so the sample must be the bare word — `keystrokeCount` would NOT match,
    // which is a real limit of this detector and better stated than discovered.
    expect(SURVEILLANCE.test('const keystroke = e.key;')).toBe(true);
    // …and NOT on a customer's attachment, which is a real product concept (U8).
    expect(SURVEILLANCE.test("subject = 'Screenshot — Bonus';")).toBe(false);
    // …and do not fire on the things that legitimately exist.
    expect(WFM_VOCABULARY.test('await presence.setState(...)')).toBe(false);
    expect(PRESENCE_AGGREGATE.test('await db.operatorPresence.findMany({ where })')).toBe(false);
    expect(SURVEILLANCE.test('const lastSeenAt = new Date();')).toBe(false);
  });

  it('no WFM aggregate vocabulary exists anywhere in the product', () => {
    // If this fires, the question is not "is the guard inconvenient" — it is whether the operator has
    // UN-parked WFM. It was deferred twice; the third time should be a decision, not a commit.
    expect(FILES.filter((f) => WFM_VOCABULARY.test(read(f))).map(rel)).toEqual([]);
  });

  it('nothing counts, groups or aggregates over presence or its history', () => {
    expect(FILES.filter((f) => PRESENCE_AGGREGATE.test(read(f))).map(rel)).toEqual([]);
  });

  it('⭐ nothing records what an operator is looking at', () => {
    // The separate, undecided surveillance question. A heartbeat says a session is alive; it may
    // never say what is on the screen.
    expect(FILES.filter((f) => SURVEILLANCE.test(read(f))).map(rel)).toEqual([]);
  });

  it('the presence transition payload cannot carry a session or a screen, by allow-list', () => {
    // The enforcement FR-037 actually points at. The guard above is a net; THIS is the wall.
    const payload = readFileSync(
      resolve(REPO_ROOT, 'libs/common/src/transitions/payload.ts'),
      'utf8',
    );
    const line = payload.split('\n').find((l) => l.includes("'operator.presence_changed':")) ?? '';
    expect(line).toContain("['from', 'to', 'cause']");
    expect(line).not.toMatch(/session|device|screen|panel/i);
  });
});
