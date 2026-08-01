import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toDetailWire, toSummaryWire } from './wire';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const CHATS_PROTO = join(ROOT, 'libs', 'proto', 'crm', 'chats', 'v1', 'chats.proto');

/**
 * T033 (feature 023, roadmap 4.18) — **the row→wire mappers must cover the contract.**
 *
 * ── Why, and why for THIS feature specifically ──────────────────────────────────────────────────
 * The gateway's explicit player allow-list has dropped a newly declared field **twice** (020's
 * `brandId`, 022's `personId`), both found only by a live run, because proto3 omits defaults: an
 * unprojected string and an empty one are both simply absent, so the loss reads as "no value for this
 * customer". `player-projection-covers-contract.spec.ts` made that obligation mechanical for players.
 *
 * The conversation path has the same shape one layer down. `toSummaryWire` / `toDetailWire` are
 * explicit maps for the same good reason a spread is refused elsewhere — but nothing obliged them to
 * grow when the contract did, and the title is precisely a field whose absence looks like "this
 * conversation has no title yet", which is a legal state. It would have been the third instance.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
 * It does not force every declared field onto the wire: `first_reply_sla` is composed by the
 * controller from a different repository, and it is excluded BY NAME with that reason — and asserted
 * to still be composed there, so the escape hatch cannot quietly grow.
 */

/** Field names declared in a proto message, in declaration order. */
function protoFields(proto: string, message: string): string[] {
  const body = new RegExp(String.raw`message\s+${message}\s*\{([\s\S]*?)\n\}`).exec(proto)?.[1] ?? '';
  return [...body.matchAll(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => m[1]!);
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const summaryRow = {
  id: 'c-1',
  brand_id: 'brand-a',
  player_id: 'p-1',
  status: 'open',
  priority: 'normal',
  assignee_operator_id: 'op-1',
  channel: 'chat',
  created_at: new Date('2026-08-04T10:00:00.000Z'),
  updated_at: new Date('2026-08-04T11:00:00.000Z'),
  subject: 'не пришёл депозит',
};

const detailRow = {
  ...summaryRow,
  reference: 'T-1',
  category: 'payments',
  sub_category: 'deposit',
  classified_by: 'ai',
  subject_source: 'auto',
};

/**
 * Declared on the contract but composed elsewhere, each with the reason.
 *
 * `first_reply_sla` is a nested message read from `ConversationSlaState` by a different repository and
 * attached by the controller (feature 014). It is not a column on the conversation row, so a row→wire
 * mapper has nothing to project — and `last_activity_at` is `updated_at` under another name, which the
 * name-based comparison cannot see.
 */
const COMPOSED_ELSEWHERE = ['first_reply_sla'];
const RENAMED_ON_THE_WIRE: Record<string, string> = { last_activity_at: 'updated_at' };

describe('T033 — the conversation mappers project every field the contract declares', () => {
  const proto = readFileSync(CHATS_PROTO, 'utf8');
  const summaryDeclared = protoFields(proto, 'ConversationSummary');
  const detailDeclared = protoFields(proto, 'Conversation');

  const summaryKeys = Object.keys(toSummaryWire(summaryRow)).map(snake);
  const detailKeys = Object.keys(toDetailWire(detailRow)).map(snake);

  it('the scan found both contracts and plausible field counts (nothing below can pass vacuously)', () => {
    expect(summaryDeclared.length).toBeGreaterThan(8);
    expect(detailDeclared.length).toBeGreaterThan(12);
    expect(summaryDeclared).toContain('id');
    expect(detailDeclared).toContain('reference');
    expect(summaryKeys.length).toBeGreaterThan(8);
    expect(detailKeys.length).toBeGreaterThan(12);
  });

  it('ConversationSummary: every declared field is projected', () => {
    const projected = new Set([...summaryKeys, ...Object.keys(RENAMED_ON_THE_WIRE)]);
    const missing = summaryDeclared.filter(
      (f) => !projected.has(f) && !COMPOSED_ELSEWHERE.includes(f),
    );
    expect(missing).toEqual([]);
  });

  it('Conversation (detail): every declared field is projected', () => {
    const projected = new Set([...detailKeys, ...Object.keys(RENAMED_ON_THE_WIRE)]);
    const missing = detailDeclared.filter(
      (f) => !projected.has(f) && !COMPOSED_ELSEWHERE.includes(f),
    );
    expect(missing).toEqual([]);
  });

  it('nothing is projected that the contract does not declare (a stale entry projects nothing)', () => {
    // The other direction: a renamed proto field leaving a dead mapper entry behind would read as
    // "still exposed" while exposing nothing — the same disease as a permanently-false authz branch.
    const knownSummary = new Set([...summaryDeclared, ...Object.values(RENAMED_ON_THE_WIRE)]);
    const knownDetail = new Set([...detailDeclared, ...Object.values(RENAMED_ON_THE_WIRE)]);
    expect(summaryKeys.filter((k) => !knownSummary.has(k))).toEqual([]);
    expect(detailKeys.filter((k) => !knownDetail.has(k))).toEqual([]);
  });

  it('the TITLE specifically is on both — the field this test was written for', () => {
    expect(summaryDeclared).toContain('subject');
    expect(detailDeclared).toContain('subject');
    expect(summaryKeys).toContain('subject');
    expect(detailKeys).toContain('subject');
    expect(toSummaryWire(summaryRow).subject).toBe('не пришёл депозит');
  });

  it('the SOURCE is on the detail and deliberately NOT on the summary', () => {
    // A list does not need to know how a title was set, and the summary is the widest-fanout message
    // in the product. Asserted in both directions so "not on the summary" stays a decision.
    expect(detailDeclared).toContain('subject_source');
    expect(detailKeys).toContain('subject_source');
    expect(summaryDeclared).not.toContain('subject_source');
    expect(summaryKeys).not.toContain('subject_source');
  });

  it('an open window projects EMPTY, never a placeholder — the dash is a rendering rule (ADR 0044)', () => {
    const open = toDetailWire({ ...detailRow, subject: null, subject_source: null });
    expect(open.subject).toBe('');
    expect(open.subjectSource).toBe('');
  });

  it('the exclusion is still true: first_reply_sla is composed by the controller, not the mapper', () => {
    for (const name of COMPOSED_ELSEWHERE) {
      expect(detailDeclared).toContain(name);
      expect(detailKeys).not.toContain(name);
    }
  });

  it('the field-name conversion is exercised (so the comparisons above are real)', () => {
    expect(snake('assigneeOperatorId')).toBe('assignee_operator_id');
    expect(snake('subjectSource')).toBe('subject_source');
    expect(snake('subject')).toBe('subject');
  });
});
