import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../src/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { AuditReadController } from '../src/audit/audit.grpc.controller';

/**
 * T025 (feature 015) — cross-account isolation for the audit trail (Principle I / SC-003).
 *
 * The trap is deliberate: both accounts hold entries with the SAME `target_ref` and the same action. An audit
 * row records who touched what, so a scoping mistake here does not leak product data — it leaks one tenant's
 * accountability record to another, which is strictly worse: it exposes both the target and the fact that
 * someone was watching.
 *
 * The fake `forAccount(acc)` reproduces what the feature-007 extension does — confines every operation to
 * `acc` — so "not visible" here is the STRUCTURAL outcome of scoping, not a filter applied afterwards.
 *
 * This file is intentionally identical in auth, users and chats: the table is duplicated per service, so the
 * isolation guarantee has to be asserted per service too.
 */
interface Row {
  id: string;
  account_id: string;
  [k: string]: unknown;
}

const entries: Row[] = [
  {
    id: 'e-ours',
    account_id: 'acc-1',
    actor_user_id: 'god',
    actor_kind: 'user',
    actor_ref: null,
    under_preview: false,
    action: 'permission.grant',
    // The SAME target id exists in both accounts — the trap.
    target_ref: 'shared-target',
    detail_json: { scope: 'user' },
    created_at: new Date('2026-07-27T12:00:00Z'),
  },
  {
    id: 'e-theirs',
    account_id: 'acc-2',
    actor_user_id: 'their-admin',
    actor_kind: 'user',
    actor_ref: null,
    under_preview: false,
    action: 'permission.grant',
    target_ref: 'shared-target',
    detail_json: { scope: 'user' },
    created_at: new Date('2026-07-27T13:00:00Z'),
  },
];

const writes: { account: string; data: Row }[] = [];

function scopedFor(acc: string) {
  const own = () => entries.filter((e) => e.account_id === acc);
  return {
    auditEntry: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          own().filter((e) => {
            if (where.actor_user_id && e.actor_user_id !== where.actor_user_id) return false;
            if (where.target_ref && e.target_ref !== where.target_ref) return false;
            return true;
          }),
        ),
      create: ({ data }: { data: Row }) => {
        writes.push({ account: acc, data });
        return Promise.resolve({ ...data, id: 'new' });
      },
    },
  } as Record<string, unknown>;
}

const forAccount = jest.fn((acc: string) => scopedFor(acc));
const prisma = { forAccount } as unknown as PrismaService;

function md(accountId: string, perms = ['platform.audit.view']): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'god');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

const controller = () => new AuditReadController(new AuditRepository(prisma));

beforeEach(() => {
  writes.length = 0;
  forAccount.mockClear();
});

describe('the audit trail is account-scoped', () => {
  it('a read sees only this account’s entries', async () => {
    const res = await controller().listAuditEntries({}, md('acc-1'));
    expect(res.entries.map((e) => e.id)).toEqual(['e-ours']);
    expect(JSON.stringify(res)).not.toContain('their-admin');
    expect(forAccount).toHaveBeenCalledWith('acc-1');
  });

  it('the other account sees only its own', async () => {
    const res = await controller().listAuditEntries({}, md('acc-2'));
    expect(res.entries.map((e) => e.id)).toEqual(['e-theirs']);
  });

  it('*** filtering by a SHARED target does not cross the boundary ***', async () => {
    const res = await controller().listAuditEntries({ targetRef: 'shared-target' }, md('acc-1'));
    expect(res.entries.map((e) => e.id)).toEqual(['e-ours']);
  });

  it('filtering by the OTHER account’s actor returns nothing, not their rows', async () => {
    const res = await controller().listAuditEntries({ actorUserId: 'their-admin' }, md('acc-1'));
    expect(res.entries).toEqual([]);
  });

  it('a write is stamped with the caller’s account, never one from the request', async () => {
    await new AuditRepository(prisma).append('acc-1', {
      action: 'audit.read',
      actorUserId: 'god',
      targetRef: 'acc-1',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.account).toBe('acc-1');
    expect(writes[0]!.data.account_id).toBe('acc-1');
  });

  it('a call with no account context is refused (fail-closed)', async () => {
    const bare = new Metadata();
    bare.set('x-actor-permissions', 'platform.audit.view');
    await expect(controller().listAuditEntries({}, bare)).rejects.toBeInstanceOf(RpcException);
    expect(forAccount).not.toHaveBeenCalled();
  });
});
