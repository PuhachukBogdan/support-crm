import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T011 + T012 + T023 (feature 023, roadmap 4.8a) — three properties of the transition stream that are
 * only true if nothing in the repository violates them, so they are asserted structurally rather than
 * hoped for.
 *
 *   1. **Append-only.** No update, no delete, anywhere, in any service. Stronger than the audit
 *      trail, which is also append-only but IS trimmed by a retention job. Here no such job exists:
 *      the windows are 🅿 provisional pending the operator's answer on retention (Q1) and SEC-25, and
 *      deleting history on an unconfirmed number is exactly what feature 018 refused when it
 *      implemented `record.open` and then reverted it.
 *   2. **Nothing branches on a transition type name.** The same discipline as 011 permissions /
 *      014 automation vocabulary / 015 audit actions / 016 upload purposes / 017 export scopes /
 *      021 UI preferences. A `switch` on a type name is how a closed catalogue quietly becomes a set
 *      of special cases.
 *   3. **Reopen is DERIVED, never counted.** FR-013: a maintained counter can disagree with the
 *      transitions it came from, and the disagreement is invisible.
 */
const ROOT = join(__dirname, '..', '..');
const SERVICES = ['chats', 'users', 'auth', 'worker', 'gateway', 'brands'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'generated' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const sources = SERVICES.flatMap((s) => walk(join(ROOT, 'services', s, 'src'))).concat(
  walk(join(ROOT, 'libs', 'common', 'src')),
);
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));
const rel = (f: string) => f.slice(ROOT.length + 1).replace(/\\/g, '/');

describe('the transition stream is append-only and never trimmed', () => {
  it('scanned every service (guards against a vacuous pass)', () => {
    expect(sources.length).toBeGreaterThan(150);
  });

  it('no code updates or deletes a transition — in ANY service', () => {
    const banned = /conversationTransition\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;
    const offenders = sources.filter((f) => banned.test(read(f))).map(rel);
    // If this fires, ask whether the retention DECISION has been made (Q1 / SEC-25) — not whether the
    // guard is inconvenient. The job comes after the policy, never before it.
    expect(offenders).toEqual([]);
  });

  it('no raw-SQL escape hatch touches the table either', () => {
    const offenders = sources
      .filter((f) => /\$executeRaw|\$queryRaw/.test(read(f)) && /ConversationTransition/i.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  // ── Feature 025 (roadmap 5.9): the stream gained a SECOND writer, so the guard gains a second
  // table. Append-only was never a property of one table; it is a property of the stream, and a
  // guard that only knew about `chats` would have quietly stopped covering half of it.
  it('no code updates or deletes an OPERATOR transition either', () => {
    const banned = /operatorTransition\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;
    const offenders = sources.filter((f) => banned.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no raw-SQL escape hatch touches the operator table either', () => {
    const offenders = sources
      .filter((f) => /\$executeRaw|\$queryRaw/.test(read(f)) && /OperatorTransition/i.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the operator detector works on planted samples too', () => {
    const banned = /operatorTransition\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;
    expect(banned.test('await tx.operatorTransition.deleteMany({ where: {} })')).toBe(true);
    expect(banned.test('await tx.operatorTransition.create({ data })')).toBe(false);
  });

  it('its own detector works on planted samples', () => {
    const banned = /conversationTransition\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;
    expect(banned.test('await tx.conversationTransition.deleteMany({ where: {} })')).toBe(true);
    expect(banned.test('await tx.conversationTransition.create({ data })')).toBe(false);
    // A retraction comment explaining why deletion is absent must not trip the guard.
    expect(banned.test(stripComments('// never conversationTransition.deleteMany(...) — see Q1'))).toBe(false);
  });
});

describe('nothing branches on a transition type name (T012)', () => {
  const CATALOGUE = 'libs/common/src/transitions/catalogue.ts';

  it('no comparison or switch on a type literal outside the catalogue', () => {
    // A type literal is dotted and lower-snake, e.g. 'conversation.status_changed'. Its only legal
    // homes are the catalogue, the payload allow-list keyed by it, and the builders that name one.
    const literal = /['"`](conversation|escalation|operator|staff|contact)\.[a-z_]+['"`]/;
    const branch = /(===|!==|switch\s*\(|case\s+)/;
    const offenders = sources
      .filter((f) => {
        const p = rel(f);
        if (p === CATALOGUE || p.includes('transitions/payload')) return false;
        const code = read(f);
        if (!literal.test(code)) return false;
        // Only flag when a literal appears on a line that also branches.
        return code
          .split('\n')
          .some((line) => literal.test(line) && branch.test(line));
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('reopen is derived from status transitions, never counted (FR-013)', () => {
  it('no reopen counter exists on the conversation or anywhere else', () => {
    const banned = /reopen_count|reopenCount|reopens_total/;
    const offenders = sources.filter((f) => banned.test(read(f))).map(rel);
    expect(offenders).toEqual([]);

    const schema = readFileSync(
      join(ROOT, 'services', 'chats', 'prisma', 'schema.prisma'),
      'utf8',
    );
    expect(banned.test(schema)).toBe(false);
  });

  it('the catalogue defines no reopen TYPE either — it is a reading, not an event', () => {
    const catalogue = readFileSync(join(ROOT, CATALOGUE_PATH), 'utf8');
    expect(/['"`][a-z]+\.reopen/.test(catalogue)).toBe(false);
  });
});

const CATALOGUE_PATH = join('libs', 'common', 'src', 'transitions', 'catalogue.ts');
