import {
  parseSchema,
  hasField,
  getField,
  columnIsIndexed,
} from '../../../../tests/data-model/schema-scan';

/**
 * T006 (feature 012) — structural proof of the Chats-core schema delta and the invariants the
 * conversation/message domain relies on. Reads the schema as TEXT (Track A, Docker-independent).
 * FAILS before the `mentions` delta, PASSES after.
 *
 * (Repo-wide guards already cover chats too: `tests/data-model/no-cross-service-fk.spec.ts`
 * — Principle VIII, `reserved-fields.spec.ts` — ADR 0027, `account-scope-coverage.spec.ts`
 * — Principle I. This spec adds the 012-specific assertions and re-asserts the two the analyze
 * pass flagged, FR-006 / FR-017, at the chats level.)
 */
describe('chats_db schema — feature 012 (chats core)', () => {
  const models = parseSchema('chats');
  const byName = (n: string) => models.find((m) => m.name === n)!;

  it('Message gains the mentions[] capture field (roadmap 4.2 / R6)', () => {
    const msg = byName('Message');
    expect(msg).toBeDefined();
    expect(hasField(msg, 'mentions')).toBe(true);
    const f = getField(msg, 'mentions')!;
    expect(f.list).toBe(true); // String[]
    expect(f.baseType).toBe('String'); // soft refs, not a relation
    expect(f.isRelation).toBe(false);
  });

  it('Conversation & Message carry the tenant seam (Principle I)', () => {
    expect(hasField(byName('Conversation'), 'account_id')).toBe(true);
    expect(hasField(byName('Message'), 'account_id')).toBe(true);
  });

  it('hot columns are indexed for keyset paths (Principle VII)', () => {
    const conv = byName('Conversation');
    expect(columnIsIndexed(conv, 'account_id')).toBe(true); // account_id+status / account_id+player_id
    expect(columnIsIndexed(conv, 'player_id')).toBe(true);
    const msg = byName('Message');
    expect(columnIsIndexed(msg, 'conversation_id')).toBe(true); // conversation_id+created_at thread keyset
  });

  it('reserved classification fields are still present (ADR 0027 / FR-006)', () => {
    const conv = byName('Conversation');
    for (const f of ['category', 'sub_category', 'classified_by', 'player_id']) {
      expect(hasField(conv, f)).toBe(true);
    }
  });

  it('cross-service references are SOFT (scalar, no FK) — Principle VIII / FR-017', () => {
    const conv = byName('Conversation');
    for (const f of ['brand_id', 'player_id', 'assignee_operator_id']) {
      expect(getField(conv, f)!.isRelation).toBe(false);
    }
    // author_id (operator/player, owned elsewhere) is a soft ref too.
    expect(getField(byName('Message'), 'author_id')!.isRelation).toBe(false);
  });
});
