import { parseSchema, type Field, type Model } from './schema-scan';

/**
 * T017 (feature 025, roadmap 5.9 — FR-004 / SC-010): **two writers, ONE envelope.**
 *
 * ── Why this test exists ────────────────────────────────────────────────────────────────────────
 * Until feature 025 the durable transition stream had exactly one writer, `chats`. Presence made
 * `users` the second, and U7 forbids a shared cross-service table — Principle VIII makes it
 * impossible anyway, since a shared table is a cross-service join by another name. So there are two
 * tables, permanently.
 *
 * But the downstream B2 aggregate store reads **one logical stream**. That is only achievable if the
 * two tables have the same shape, and "the same shape" maintained by hand across two files is "the
 * same shape until somebody edits one of them". The *shaping function* is already shared
 * (`libs/common/src/transitions/row.ts`), which makes the ROWS identical; this asserts the same of
 * the COLUMNS they land in — the half a shared function cannot cover.
 *
 * Get this wrong and nothing breaks today. It breaks whenever the aggregator is written, at which
 * point the fix is a migration on historical data rather than an edit.
 */

const CHATS = 'ConversationTransition';
const USERS = 'OperatorTransition';

function model(service: 'chats' | 'users', name: string): Model {
  const m = parseSchema(service).find((x) => x.name === name);
  if (!m) throw new Error(`${name} is missing from the ${service} schema`);
  return m;
}

/** Name → written type, for scalar columns only. Relations are not part of the envelope. */
function columns(m: Model): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of m.fields.filter((x: Field) => !x.isRelation)) out[f.name] = f.rawType;
  return out;
}

const indexColumns = (m: Model) =>
  m.indexes.filter((i) => i.kind === 'index').map((i) => i.columns.join(','));

describe('the transition stream has two writers and one envelope (feature 025)', () => {
  it('both models exist and were actually parsed (anti-vacuous)', () => {
    // Without this, a renamed model would make every comparison below pass against `{}`.
    expect(Object.keys(columns(model('chats', CHATS))).length).toBeGreaterThan(8);
    expect(Object.keys(columns(model('users', USERS))).length).toBeGreaterThan(8);
  });

  it('⭐ agree column for column — same names, same types, same nullability', () => {
    // `rawType` carries the `?`, so this compares nullability too. A `String` that became a
    // `String?` on one side only is exactly the drift that would make a shared reader wrong about
    // half its input.
    expect(columns(model('users', USERS))).toEqual(columns(model('chats', CHATS)));
  });

  it('the envelope is the one U7 specifies', () => {
    // Spelled out rather than derived from either schema: this is the contract with the aggregate
    // store, and it must not silently become "whatever the two tables happen to agree on".
    expect(Object.keys(columns(model('users', USERS))).sort()).toEqual([
      'account_id',
      'actor_kind',
      'actor_ref',
      'correlation_id',
      'created_at',
      'dims_json',
      'id',
      'occurred_at',
      'payload_json',
      'subject_id',
      'subject_kind',
      'type',
    ]);
  });

  it('the comparison can actually fail (the detector is proven, not assumed)', () => {
    // Prove the comparator distinguishes shapes at all, by comparing against a model that is
    // deliberately different. A test that only ever compares two equal things would pass just as
    // happily if `columns()` returned a constant.
    const unrelated = columns(model('users', 'OperatorPresence'));
    expect(unrelated).not.toEqual(columns(model('users', USERS)));
  });

  it('both carry the aggregator’s watermark index, with `id` breaking same-instant ties', () => {
    // The 015 lesson: two rows in the same millisecond must still page deterministically, which is
    // why `id` is the third column and not an afterthought.
    for (const [svc, name] of [
      ['chats', CHATS],
      ['users', USERS],
    ] as const) {
      expect(indexColumns(model(svc, name))).toContain('account_id,occurred_at,id');
    }
  });

  it('both can answer "reconstruct this subject’s history"', () => {
    for (const [svc, name] of [
      ['chats', CHATS],
      ['users', USERS],
    ] as const) {
      expect(indexColumns(model(svc, name))).toContain('account_id,subject_id,occurred_at');
    }
  });

  it('neither table carries a foreign key to anything', () => {
    // A relation here would be a join the aggregate store cannot follow — and, across services, a
    // Principle VIII violation. `subject_id` and `actor_ref` are soft refs by design.
    for (const [svc, name] of [
      ['chats', CHATS],
      ['users', USERS],
    ] as const) {
      expect(model(svc, name).fields.filter((f) => f.isRelation)).toEqual([]);
    }
  });
});
