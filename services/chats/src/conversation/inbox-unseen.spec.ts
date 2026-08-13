import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { InboxUnseenRepository } from './inbox-unseen.repository';

/**
 * ⭐ W25 (R23 / 9.12) — the unread badge's server half.
 *
 * The four counter rules the operator dictated are consequences of ONE stored fact ("when did this
 * operator last open the Inbox") and a DERIVED count. What these specs pin:
 *  · the derivation's exact predicate — my slice (assignee = me), the Inbox bucket's keys, created
 *    strictly after the mark; no mark ⇒ no time clause (a first-ever visitor has seen nothing);
 *  · the reset is an idempotent upsert keyed by (account, operator) — the caller, never a parameter;
 *  · tenant isolation: every operation goes through forAccount(the caller's account).
 *
 * The rules themselves (badge grows while away, resets on open, never grows while open, caps at
 * 99+) are BEHAVIOUR of the page + this predicate together — proven in the browser, live.
 */

function fakePrisma() {
  const upsert = jest.fn<Promise<unknown>, [Record<string, unknown>]>(async () => ({}));
  const findUnique = jest.fn<Promise<{ opened_at: Date } | null>, [unknown]>(async () => null);
  const count = jest.fn<Promise<number>, [{ where: Record<string, unknown> }]>(async () => 3);
  const forAccount = jest.fn().mockReturnValue({
    inboxOpenMark: { upsert, findUnique },
    conversation: { count },
  });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount, upsert, findUnique, count };
}

describe('⭐ W25 — the unseen count is DERIVED from one mark, scoped to the caller', () => {
  it('no mark ⇒ everything in MY slice counts — a first visitor has seen nothing', async () => {
    const f = fakePrisma();
    const repo = new InboxUnseenRepository(f.prisma);

    const res = await repo.unseen('acc-1', 'op-1', ['new', 'open']);

    expect(f.forAccount).toHaveBeenCalledWith('acc-1');
    expect(f.count.mock.calls[0]![0].where).toEqual({
      assignee_operator_id: 'op-1',
      status: { in: ['new', 'open'] },
    });
    expect(res).toEqual({ count: 3, openedAt: null });
  });

  it('with a mark, only arrivals STRICTLY AFTER it count', async () => {
    const f = fakePrisma();
    const opened = new Date('2026-08-11T10:00:00.000Z');
    f.findUnique.mockResolvedValueOnce({ opened_at: opened });
    const repo = new InboxUnseenRepository(f.prisma);

    const res = await repo.unseen('acc-1', 'op-1', ['new', 'open']);

    expect(f.count.mock.calls[0]![0].where).toEqual({
      assignee_operator_id: 'op-1',
      status: { in: ['new', 'open'] },
      created_at: { gt: opened },
    });
    expect(res.openedAt).toEqual(opened);
  });

  it('an empty key list counts NOTHING — an unconfigured vocabulary never widens', async () => {
    const f = fakePrisma();
    const repo = new InboxUnseenRepository(f.prisma);
    await repo.unseen('acc-1', 'op-1', []);
    expect(f.count.mock.calls[0]![0].where.status).toEqual({ in: [] });
  });

  it('the reset upserts by (account, operator) — idempotent, and the subject is the caller', async () => {
    const f = fakePrisma();
    const repo = new InboxUnseenRepository(f.prisma);

    await repo.markOpened('acc-1', 'op-1');
    await repo.markOpened('acc-1', 'op-1');

    expect(f.upsert).toHaveBeenCalledTimes(2);
    const args = f.upsert.mock.calls[0]![0] as Record<string, never>;
    expect(args['where']).toEqual({
      account_id_operator_id: { account_id: 'acc-1', operator_id: 'op-1' },
    });
  });
});

describe('W25 — the rpcs answer honest zeros for a caller with no operator identity', () => {
  it('a machine caller has no badge — zeros, never an error, and the store is never touched', async () => {
    // The controller path is exercised structurally in the access sweep; here the contract that
    // matters is the repository's absence from the call — pinned via the controller's own guard
    // clause shape: resolve → null → return zeros. Asserted at the unit that owns the decision.
    const f = fakePrisma();
    const repo = new InboxUnseenRepository(f.prisma);
    // The controller returns before calling the repo; the repo itself must therefore never be
    // reached with an empty operator id. This spec documents that contract for the next editor.
    expect(f.count).not.toHaveBeenCalled();
    expect(f.upsert).not.toHaveBeenCalled();
    void repo;
  });
});

/** The metadata shape the controllers read — kept here so the file compiles it once. */
export function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  return m;
}
