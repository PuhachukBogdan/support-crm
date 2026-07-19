import { withAccountScope, scopeArgs, AccountScopeError } from '@crm/common';

/**
 * US1 / SC-002, SC-003 (feature 007): the two-account narrative. In account A's context, a query
 * that omits (or mis-states) the account filter can never reach account B; an update/delete targeting
 * a B row by id affects zero rows; and a call with no context fails closed. Docker-independent
 * (Track A) — asserts the enforced predicate; the live cross-account SELECT runs on beton-test (B).
 */
const SCOPED = ['Player', 'Conversation'];

type Args = { where?: Record<string, unknown>; data?: Record<string, unknown> };

describe('cross-account read isolation', () => {
  it('account A reads only account A, even with no where supplied', () => {
    const args = scopeArgs('Player', 'findMany', {}, 'acc-A', SCOPED) as Args;
    expect(args.where).toEqual({ account_id: 'acc-A' });
  });

  it('a query pretending to be account B is forced back to account A (no leak)', () => {
    const args = scopeArgs('Player', 'findMany', { where: { account_id: 'acc-B' } }, 'acc-A', SCOPED) as Args;
    expect(args.where?.account_id).toBe('acc-A'); // B is never returned
  });

  it('a caller filter narrows WITHIN the account, never escapes it', () => {
    const args = scopeArgs('Conversation', 'findMany', { where: { status: 'open' } }, 'acc-A', SCOPED) as Args;
    expect(args.where).toEqual({ status: 'open', account_id: 'acc-A' });
  });
});

describe('cross-account write isolation', () => {
  it.each(['update', 'delete'])('%s of an account-B row by id is scoped to account A (zero rows)', (op) => {
    const args = scopeArgs('Conversation', op, { where: { id: 'conv-owned-by-B' }, data: {} }, 'acc-A', SCOPED) as Args;
    // account_id is AND-ed into the unique where → the B-owned row is invisible → P2025 / zero rows.
    expect(args.where).toEqual({ id: 'conv-owned-by-B', account_id: 'acc-A' });
  });

  it('create cannot plant a row into another account', () => {
    const args = scopeArgs(
      'Conversation',
      'create',
      { data: { account_id: 'acc-B', status: 'open' } },
      'acc-A',
      SCOPED,
    ) as Args;
    expect(args.data?.account_id).toBe('acc-A');
  });
});

describe('fail-closed without a context', () => {
  it('withAccountScope throws when no account is supplied', () => {
    expect(() => withAccountScope({ $extends: () => ({}) } as never, '', { scopedModels: SCOPED })).toThrow(
      AccountScopeError,
    );
  });
});
