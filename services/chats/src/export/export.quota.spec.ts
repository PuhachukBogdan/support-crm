import { EXPORT_SCOPES } from '@crm/common';
import { ExportQuota, QuotaExhaustedError } from './export.quota';

/**
 * T044 (feature 017, US3) — **the quota is per REQUESTER, not per server instance** (FR-016 / SEC-22,
 * research R11).
 *
 * FR-016 is deliberately phrased as a property rather than a mechanism, because the first draft named
 * feature 010's `RateLimiter` — which documents itself as per-instance in-memory. Under N replicas that
 * makes the effective quota **N × max**: every Track-A test passes and the limit is false in production.
 * For invite throttling at low QPS that was an accepted trade; for a limit whose stated purpose is
 * bounding **PII extraction volume** it is not a quota at all.
 *
 * So the count is a Postgres range count over the table that already records exactly this. The tests
 * below are therefore about WHERE the number comes from as much as what it is.
 */
const SCOPE = EXPORT_SCOPES.conversations;
const NOW = new Date('2026-07-28T12:00:00.000Z');

function quota(count: number) {
  const calls: Array<{ accountId: string; requestedBy: string; since: Date }> = [];
  const repo = {
    countInWindow: jest.fn(async (accountId: string, requestedBy: string, since: Date) => {
      calls.push({ accountId, requestedBy, since });
      return count;
    }),
  };
  return { q: new ExportQuota(repo as never), repo, calls };
}

describe('*** the count comes from the TABLE, per requester, over a trailing window ***', () => {
  it('the query is scoped to the account AND the requester', async () => {
    const h = quota(0);
    await h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW);

    // Per requester: one busy analyst must not exhaust the allowance of everyone else in the account.
    // Per account: the count can never span tenants (Principle I — `countInWindow` goes via `forAccount`).
    expect(h.calls[0]!.accountId).toBe('acc-1');
    expect(h.calls[0]!.requestedBy).toBe('user-1');
  });

  it('the window start is derived from the catalogue, not from a constant here', async () => {
    const h = quota(0);
    await h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW);

    expect(NOW.getTime() - h.calls[0]!.since.getTime()).toBe(SCOPE.quotaWindowSeconds * 1000);
  });

  it('a tighter scope row tightens the quota with no code change (FR-016 as configuration)', async () => {
    const h = quota(2);
    const tight = { ...SCOPE, quotaMax: 2, quotaWindowSeconds: 60 };
    // Same code, different data: 2 used against a max of 2 refuses, and the window is the row's.
    await expect(h.q.assertWithinQuota('acc-1', 'user-1', tight, NOW)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
    expect(NOW.getTime() - h.calls[0]!.since.getTime()).toBe(60_000);
  });

  it('nothing in this unit holds state between calls', async () => {
    // The property the in-memory limiter could not have: two instances of this class agree, because
    // neither of them remembers anything. That is what makes the limit hold across replicas.
    const h = quota(0);
    const other = new ExportQuota(h.repo as never);
    await h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW);
    await other.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW);
    expect(h.repo.countInWindow).toHaveBeenCalledTimes(2);
  });
});

describe('the boundary', () => {
  it.each([
    [0, 'passes'],
    [SCOPE.quotaMax - 1, 'passes'],
  ])('%i used %s', async (used) => {
    const h = quota(used);
    await expect(h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW)).resolves.toBeUndefined();
  });

  it.each([[SCOPE.quotaMax], [SCOPE.quotaMax + 3]])('%i used refuses', async (used) => {
    const h = quota(used);
    await expect(h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW)).rejects.toBeInstanceOf(
      QuotaExhaustedError,
    );
  });

  it('the refusal carries a retry hint and no tenant data', async () => {
    const h = quota(SCOPE.quotaMax);
    const err = await h.q
      .assertWithinQuota('acc-1', 'user-1', SCOPE, NOW)
      .then(() => null)
      .catch((e: QuotaExhaustedError) => e);

    expect(err!.retryAfterSeconds).toBe(SCOPE.quotaWindowSeconds);
    // The message reaches a client and a log. It names neither the requester nor the account.
    expect(err!.message).not.toContain('acc-1');
    expect(err!.message).not.toContain('user-1');
  });
});

describe('*** FAILED exports count against the quota ***', () => {
  it('the window count is of rows CREATED, with no status filter', async () => {
    const h = quota(0);
    await h.q.assertWithinQuota('acc-1', 'user-1', SCOPE, NOW);

    // Asserted as an absence, which is the only way to state it: the quota asks for a COUNT over a
    // creation window and passes no status. A failed export still read the source data and still did the
    // work, so excluding failures would make "retry until it works" an unbounded extraction path.
    const args = h.repo.countInWindow.mock.calls[0] as unknown as unknown[];
    expect(args).toHaveLength(3);
    expect(JSON.stringify(args)).not.toContain('status');
  });
});
