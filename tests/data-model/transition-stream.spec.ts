import { parseSchema, hasField } from './schema-scan';
import { SCOPED_MODELS as CHATS } from '../../services/chats/src/prisma.scoped-models';

/**
 * T004 (feature 023, roadmap 4.8a) — the transition stream's structural invariants, asserted on the
 * schema TEXT so they hold on Track A, where there is no database.
 *
 * The behavioural half — a cross-account read returns nothing — belongs with the repository that
 * performs the read (US1) and with the live run, because a structural test cannot prove a query.
 * What IS provable here is everything that decides whether such a read can even be attempted.
 *
 * Note the division of labour with `account-scope-coverage.spec.ts`: that spec asserts the allow-list
 * EQUALS the set of models declaring `account_id`, so forgetting either half already fails the build.
 * This spec asserts the things that guard is not looking at — the ordering index, the snapshot column,
 * and the absence of the two shapes this design deliberately refused.
 */
const MODEL = 'ConversationTransition';

describe('transition stream — structural invariants (feature 023)', () => {
  const model = () => {
    const m = parseSchema('chats').find((x) => x.name === MODEL);
    if (!m) throw new Error(`${MODEL} is missing from the chats schema`);
    return m;
  };

  it('is a tenant table and is enrolled in the account-scope allow-list (Principle I)', () => {
    expect(hasField(model(), 'account_id')).toBe(true);
    expect(CHATS).toContain(MODEL);
  });

  it('carries the dimensions SNAPSHOT as a column, not as references to live rows', () => {
    // FR-003 / SC-003: renaming a brand must not rewrite history. A reference would let it.
    expect(hasField(model(), 'dims_json')).toBe(true);
    const relations = model().fields.filter((f) => f.isRelation);
    expect(relations).toEqual([]);
  });

  it('separates when it HAPPENED from when the row was written', () => {
    // They differ only under retry — conflating them makes a replayed write look like a later event.
    expect(hasField(model(), 'occurred_at')).toBe(true);
    expect(hasField(model(), 'created_at')).toBe(true);
  });

  it('can be tied to the audit entry produced by the same act', () => {
    // Two stores, one vocabulary. Neither is the other's source of truth (ADR 0046 §4).
    expect(hasField(model(), 'correlation_id')).toBe(true);
  });

  it('has the watermark/ordering index with id as the tie-breaker', () => {
    // Two transitions in the same millisecond must still page deterministically — the 015 lesson.
    const idx = model().indexes.map((i) => i.columns.join(','));
    expect(idx).toContain('account_id,occurred_at,id');
  });

  it('has the two read indexes the success criteria need', () => {
    const idx = model().indexes.map((i) => i.columns.join(','));
    expect(idx).toContain('account_id,subject_id,occurred_at'); // SC-001 reconstruct a life
    expect(idx).toContain('account_id,type,occurred_at'); // SC-002 a range of one type
  });

  it('has NO delivery-status column — the consumer reads by watermark (research R2)', () => {
    // An inert status column on the largest table in the product is the shape ADR 0038 removed.
    for (const banned of ['delivered_at', 'delivered', 'published_at', 'consumed_at']) {
      expect(hasField(model(), banned)).toBe(false);
    }
  });

  it('has NO free-text or body-shaped column — payload is typed and allow-listed', () => {
    // Principle IV / SEC-26: message text must be inexpressible here, not merely discouraged.
    for (const banned of ['body', 'text', 'message', 'subject', 'note', 'email', 'phone']) {
      expect(hasField(model(), banned)).toBe(false);
    }
  });
});

describe('conversation subject columns (feature 023, roadmap 4.18)', () => {
  const conversation = () => {
    const m = parseSchema('chats').find((x) => x.name === 'Conversation');
    if (!m) throw new Error('Conversation is missing from the chats schema');
    return m;
  };

  it('stores the title and the source that makes the freeze enforceable', () => {
    expect(hasField(conversation(), 'subject')).toBe(true);
    expect(hasField(conversation(), 'subject_source')).toBe(true);
  });

  it('does NOT duplicate actor bookkeeping on the hot row', () => {
    // Who set it and when are answered by the `conversation.subject_set` transition (data-model §4).
    expect(hasField(conversation(), 'subject_set_by')).toBe(false);
    expect(hasField(conversation(), 'subject_set_at')).toBe(false);
  });

  it('the TITLE is not indexed — search must never depend on the subject (R10 / U19)', () => {
    // It is model-generated and human-editable; an index invites building navigation on it.
    const indexed = conversation().indexes.flatMap((i) => i.columns);
    expect(indexed).not.toContain('subject');
  });

  it('the WINDOW is indexed, and ONLY as the sweep predicate — a different thing from the title', () => {
    // ⚠️ This assertion started as "`subject_source` is not indexed either", and the timeout sweep
    // (T031) then needed exactly that index: without it, `subject_source IS NULL AND created_at <= …`
    // is a sequential scan over every conversation ever created, once a minute, forever.
    //
    // The two rules do not conflict — they are about different columns. What must stay true is that
    // the index exists for the SWEEP and cannot become a navigation surface, so it is pinned to its
    // exact shape: `(subject_source, created_at)` and nothing else, and the title is never in it.
    const withSource = conversation().indexes.filter((i) => i.columns.includes('subject_source'));
    expect(withSource.map((i) => i.columns)).toEqual([['subject_source', 'created_at']]);

    // Deliberately NOT account-scoped: the sweep has no caller and therefore no account (the
    // `sla-sweep.repository.ts` reasoning), so leading with `account_id` would make the index unusable
    // for the one query it exists for.
    expect(withSource[0]!.columns[0]).toBe('subject_source');
  });
});
