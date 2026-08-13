import { InviteService } from './invite.service';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §7) — **a re-hire can actually come back.**
 *
 * The reactivation branch answered `202 reactivated`, wrote the invitation and sent the mail, while
 * leaving the person `disabled` with no role — so `register/start` refused their link and they could
 * not return. Everything reported success. Found by the live round; pinned here so the next reader
 * cannot re-derive `ensureInvitedUser`'s early return as sufficient.
 *
 * ⚠️ The second test is the one that must never be «simplified»: the same call against an ACTIVE
 * colleague must not touch them. That is what stops a stray HR event from knocking somebody out of
 * their session mid-shift, and it is a WHERE clause rather than a guard above it.
 */

type UserRow = { id: string; account_id: string; email: string; status: string };

function harness(users: UserRow[]) {
  const bindings: { user_id: string; role_id: string }[] = [];
  const prisma = {
    role: { findUnique: jest.fn(async () => ({ id: 'role-newcomer', key: 'newcomer' })) },
    invitation: { create: jest.fn(async () => ({ id: 'inv-1' })) },
    user: {
      findFirst: jest.fn(async ({ where }: { where: { email?: string; account_id?: string } }) =>
        users.find((u) => u.email === where.email && (!where.account_id || u.account_id === where.account_id)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: UserRow }) => {
        const row = { ...data, id: `u-${users.length + 1}` };
        users.push(row);
        return row;
      }),
      // The status predicate lives HERE, which is the point of the test below.
      updateMany: jest.fn(async ({ where, data }: { where: { account_id: string; email: string; status: string }; data: { status: string } }) => {
        const hit = users.filter(
          (u) => u.account_id === where.account_id && u.email === where.email && u.status === where.status,
        );
        hit.forEach((u) => (u.status = data.status));
        return { count: hit.length };
      }),
    },
    userRole: {
      create: jest.fn(async ({ data }: { data: { user_id: string; role_id: string } }) => {
        bindings.push(data);
        return data;
      }),
      createMany: jest.fn(async ({ data }: { data: { user_id: string; role_id: string }[] }) => {
        data.forEach((d) => {
          if (!bindings.some((b) => b.user_id === d.user_id && b.role_id === d.role_id)) bindings.push(d);
        });
        return { count: data.length };
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  // Constructor order: config, clock, prisma, tokens, rate limiter, email.
  const service = new InviteService(
    { INVITE_TTL: 86_400 } as never,
    { now: () => new Date('2026-08-13T00:00:00Z') } as never,
    prisma as never,
    { hashPassword: async () => 'hashed' } as never,
    { consume: jest.fn(async () => true) } as never,
    { sendInvite: jest.fn(async () => undefined) } as never,
  );
  return { service, users, bindings };
}

describe('the machine invitation, against an account that already exists', () => {
  it('*** ⭐ a DEACTIVATED colleague becomes invitable again, with the starter role ***', async () => {
    const h = harness([{ id: 'u-1', account_id: 'acc-1', email: 'back@company.test', status: 'disabled' }]);
    const out = await h.service.createProvisioningInvitation('acc-1', 'back@company.test', 'api-key:fp_1');
    expect(out.status).toBe('created');
    // Both halves, because either alone still leaves them unable to return.
    expect(h.users[0]!.status).toBe('invited');
    expect(h.bindings).toEqual([{ user_id: 'u-1', role_id: 'role-newcomer' }]);
  });

  it('*** ⛔ an ACTIVE colleague is NOT touched — no status change, no new binding ***', async () => {
    const h = harness([{ id: 'u-1', account_id: 'acc-1', email: 'working@company.test', status: 'active' }]);
    await h.service.createProvisioningInvitation('acc-1', 'working@company.test', 'api-key:fp_1');
    // A stray HR event must never knock somebody out of their session mid-shift.
    expect(h.users[0]!.status).toBe('active');
    expect(h.bindings).toEqual([]);
  });

  it('another account’s user with the same address is not reinstated (Principle I)', async () => {
    const h = harness([{ id: 'u-1', account_id: 'acc-2', email: 'back@company.test', status: 'disabled' }]);
    await h.service.createProvisioningInvitation('acc-1', 'back@company.test', 'api-key:fp_1');
    expect(h.users[0]!.status).toBe('disabled');
  });

  it('reactivating twice before the link is used does not throw on the binding', async () => {
    const h = harness([{ id: 'u-1', account_id: 'acc-1', email: 'back@company.test', status: 'disabled' }]);
    await h.service.createProvisioningInvitation('acc-1', 'back@company.test', 'api-key:fp_1');
    // The second call finds them `invited`, so the status predicate matches nothing — and that is the
    // correct no-op, not an error. HR retries are ordinary (§6).
    await h.service.createProvisioningInvitation('acc-1', 'back@company.test', 'api-key:fp_1');
    expect(h.bindings).toHaveLength(1);
  });
});
