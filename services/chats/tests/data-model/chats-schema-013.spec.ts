import { parseSchema, hasField, getField } from '../../../../tests/data-model/schema-scan';
import { SCOPED_MODELS } from '../../src/prisma.scoped-models';

/**
 * T006 (feature 013) — structural proof of the workflow schema delta: the two new account-scoped
 * tables (`CannedResponse`, `RoundRobinState`) and their uniqueness/scoping invariants. Reads the
 * schema as TEXT, so it runs on the dev box with no database (Track A).
 *
 * FAILS before the delta (models absent / unregistered), PASSES after.
 */
describe('chats_db schema — feature 013 (conversation workflow)', () => {
  const models = parseSchema('chats');
  const byName = (n: string) => models.find((m) => m.name === n)!;
  const uniqueOn = (model: string, columns: string[]) =>
    byName(model).indexes.some(
      (i) => i.kind === 'unique' && i.columns.join(',') === columns.join(','),
    );

  it('adds CannedResponse with the tenant seam and a per-account unique name', () => {
    const cr = byName('CannedResponse');
    expect(cr).toBeDefined();
    expect(hasField(cr, 'account_id')).toBe(true);
    expect(hasField(cr, 'name')).toBe(true);
    expect(hasField(cr, 'body')).toBe(true);
    expect(uniqueOn('CannedResponse', ['account_id', 'name'])).toBe(true);
    // Text only — no message/conversation relation could make it send anything (FR-009).
    expect(cr.fields.some((f) => f.isRelation)).toBe(false);
  });

  it('adds RoundRobinState keyed per (account, group), the cursor naming a PERSON', () => {
    const rr = byName('RoundRobinState');
    expect(rr).toBeDefined();
    expect(hasField(rr, 'account_id')).toBe(true);
    expect(hasField(rr, 'group_key')).toBe(true);
    expect(uniqueOn('RoundRobinState', ['account_id', 'group_key'])).toBe(true);

    /**
     * ⭐ Corrected 2026-08-13: `last_operator_id`, not `cursor Int`.
     *
     * ⚠️ An index only means something against the list it was taken from, and that list is the pool
     * of operators available RIGHT NOW — it changes length every time somebody logs on or off. So the
     * stored number silently came to mean a different colleague, skipping one and double-serving
     * another, with no error anywhere. Nullable rather than `-1`: «this desk has never routed» is an
     * absence, and a sentinel value is a second thing to remember. See `round-robin.ts`.
     */
    expect(hasField(rr, 'cursor')).toBe(false);
    const cursor = getField(rr, 'last_operator_id')!;
    expect(cursor.baseType).toBe('String');
  });

  it('both new tables are enrolled in SCOPED_MODELS (Principle I / fail-closed scoping)', () => {
    expect(SCOPED_MODELS).toContain('CannedResponse');
    expect(SCOPED_MODELS).toContain('RoundRobinState');
  });

  it('every SCOPED_MODELS entry exists in the schema and carries account_id', () => {
    for (const name of SCOPED_MODELS) {
      const m = byName(name);
      expect(m).toBeDefined();
      expect(hasField(m, 'account_id')).toBe(true);
    }
  });

  it('the assignment target is still a soft ref — no FK to another service (Principle VIII)', () => {
    // 013 writes assignee_operator_id; the operator lives in users_db and must never be joined.
    expect(getField(byName('Conversation'), 'assignee_operator_id')!.isRelation).toBe(false);
  });

  it('new tables introduce no cross-service relation of their own', () => {
    for (const name of ['CannedResponse', 'RoundRobinState'] as const) {
      for (const f of byName(name).fields) expect(f.isRelation).toBe(false);
    }
  });
});
