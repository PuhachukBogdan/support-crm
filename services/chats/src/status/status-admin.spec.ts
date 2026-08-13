import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { StatusRepository } from './status.repository';
import { StatusAdminController } from './status-admin.grpc.controller';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';

/**
 * ⭐ W15a (subpoint 3.14) — the status authoring writes. The block's invariant is the same
 * SERVER-SIDE RBAC claim as W15's: the status vocabulary decides bucketing, reporting and what
 * agents may set, so both writes must be refused at this tier below `platform.settings.manage`.
 *
 * The interesting behavioural claims: the KEY is derived and immutable; a duplicate name conflicts
 * instead of silently sharing a key; a no-op writes nothing; retirement is an UPDATE that leaves
 * the row readable (never a delete).
 */

const ROWS = [
  { key: 'st_open', category: 'open', agent_name: 'Open', end_user_name: 'Open', active: true, order: 10 },
  { key: 'st_parked', category: 'on_hold', agent_name: 'Parked', end_user_name: 'On hold', active: true, order: 20 },
];

function fakePrisma(initial = ROWS) {
  const rows = initial.map((r) => ({ ...r }));
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const auditWrites: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];

  const scoped = {
    conversationStatus: {
      findFirst: async (args: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        if (args?.where?.key !== undefined) {
          const hit = rows.find((r) => r.key === args.where!.key);
          return hit ? { ...hit } : null;
        }
        // the max-order read
        const top = [...rows].sort((a, b) => b.order - a.order)[0];
        return top ? { order: top.order } : null;
      },
      findMany: async () => rows.map((r) => ({ ...r })),
      create: (args: { data: Record<string, unknown> }) => {
        creates.push(args.data);
        if (rows.some((r) => r.key === args.data.key)) {
          const err = new Error('unique') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        rows.push({ ...(args.data as Omit<(typeof ROWS)[number], 'active'>), active: true });
        return {};
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        const hit = rows.find((r) => r.key === args.where.key);
        if (hit) Object.assign(hit, args.data);
        return { count: hit ? 1 : 0 };
      },
    },
    auditEntry: {
      create: (args: { data: Record<string, unknown> }) => {
        auditWrites.push(args.data);
        return {};
      },
    },
    $transaction: async (statements: unknown[]) => {
      batches.push(statements);
      return statements.map((s) => s ?? {});
    },
  };

  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, rows, creates, updates, auditWrites, batches };
}

const build = (prisma: PrismaService) =>
  new StatusAdminController(new StatusRepository(prisma), new AuditRepository(prisma));

function md(permissions: string[], accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', permissions.join(','));
  return m;
}

const TEAMLEAD_PERMS = ['crm.inbox.view', 'crm.conversation.reply', 'crm.templates.manage', 'crm.sla.manage'];
const ADMIN_PERMS = [...TEAMLEAD_PERMS, 'platform.settings.manage'];

describe('*** the status vocabulary is refused below `platform.settings.manage` (server-side) ***', () => {
  const guardCtx = (handler: unknown, perms: string[]) =>
    ({
      getType: () => 'rpc',
      getHandler: () => handler,
      getClass: () => StatusAdminController,
      switchToRpc: () => ({ getContext: () => md(perms) }),
    }) as never;

  it('⭐ the guard refuses BOTH writes for a teamlead-shaped permission set', () => {
    const guard = new ChatsAccessGuard(new Reflector());
    for (const h of [
      StatusAdminController.prototype.createConversationStatus,
      StatusAdminController.prototype.updateConversationStatus,
    ]) {
      expect(() => guard.canActivate(guardCtx(h, TEAMLEAD_PERMS))).toThrow(RpcException);
      expect(guard.canActivate(guardCtx(h, ADMIN_PERMS))).toBe(true); // the positive control
    }
  });

  it('both handlers declare the tenant-configuration key', () => {
    const reflector = new Reflector();
    for (const h of [
      StatusAdminController.prototype.createConversationStatus,
      StatusAdminController.prototype.updateConversationStatus,
    ]) {
      expect(reflector.get<string>(REQUIRED_CHATS_PERMISSION_KEY, h)).toBe('platform.settings.manage');
    }
  });
});

describe('creating a status', () => {
  it('⭐ derives the key from the agent name, appends order by tens, audits ONCE in ONE transaction', async () => {
    const { prisma, creates, auditWrites, batches } = fakePrisma();
    const res = await build(prisma).createConversationStatus(
      { category: 'pending', agentName: 'Waiting on Finance', endUserName: 'In review' },
      md(ADMIN_PERMS),
    );

    expect(creates[0]).toMatchObject({
      key: 'waiting_on_finance',
      category: 'pending',
      agent_name: 'Waiting on Finance',
      end_user_name: 'In review',
      order: 30, // max(20) + 10
    });
    expect(res.key).toBe('waiting_on_finance');
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({ action: 'status.config_changed', target_ref: 'waiting_on_finance' });
    expect(batches.at(-1)).toHaveLength(2);
  });

  it('a name whose key collides CONFLICTS — never two statuses silently sharing a key', async () => {
    const { prisma } = fakePrisma();
    await expect(
      build(prisma).createConversationStatus(
        { category: 'open', agentName: 'OPEN', endUserName: 'Open' }, // slugs to the existing st… no: 'open'
        md(ADMIN_PERMS),
      ),
    ).resolves.toMatchObject({ key: 'open' }); // 'open' does not collide with fixture key 'st_open'

    // The real collision: the same normalised name twice.
    await expect(
      build(prisma).createConversationStatus(
        { category: 'open', agentName: 'open', endUserName: 'Open' },
        md(ADMIN_PERMS),
      ),
    ).rejects.toThrow(RpcException);
  });

  it.each([
    [{ category: 'nope', agentName: 'X', endUserName: 'Y' }, 'unknown category'],
    [{ category: 'open', agentName: '', endUserName: 'Y' }, 'missing agent name'],
    [{ category: 'open', agentName: 'X', endUserName: '' }, 'missing end-user name'],
    [{ category: 'open', agentName: '!!!', endUserName: 'Y' }, 'a name of punctuation yields no key'],
  ])('refuses %j (%s) before anything is written', async (req) => {
    const { prisma, creates, auditWrites } = fakePrisma();
    await expect(build(prisma).createConversationStatus(req, md(ADMIN_PERMS))).rejects.toThrow(RpcException);
    expect(creates).toHaveLength(0);
    expect(auditWrites).toHaveLength(0);
  });
});

describe('editing a status', () => {
  it('⭐ renames / re-categorises by KEY and audits once — the key itself never moves', async () => {
    const { prisma, updates, auditWrites } = fakePrisma();
    const res = await build(prisma).updateConversationStatus(
      { key: 'st_parked', agentName: 'Parked (3rd party)', category: 'pending' },
      md(ADMIN_PERMS),
    );
    expect(updates[0]!.data).toEqual({ agent_name: 'Parked (3rd party)', category: 'pending' });
    expect(res.key).toBe('st_parked');
    expect(res.agentName).toBe('Parked (3rd party)');
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]!.target_ref).toBe('st_parked');
  });

  it('⭐ retirement is an UPDATE (`active:false`) — the row survives for the tickets wearing it', async () => {
    const { prisma, rows, updates } = fakePrisma();
    const res = await build(prisma).updateConversationStatus(
      { key: 'st_parked', setActive: true, active: false },
      md(ADMIN_PERMS),
    );
    expect(updates[0]!.data).toEqual({ active: false });
    expect(res.active).toBe(false);
    // Still a row — retirement must never be a delete (ON DELETE RESTRICT stands behind this).
    expect(rows.find((r) => r.key === 'st_parked')).toBeDefined();
  });

  it('a no-op is refused and writes nothing — same words sent back is not an edit', async () => {
    const { prisma, updates, auditWrites } = fakePrisma();
    await expect(
      build(prisma).updateConversationStatus(
        { key: 'st_parked', agentName: 'Parked', endUserName: 'On hold' },
        md(ADMIN_PERMS),
      ),
    ).rejects.toThrow(RpcException);
    expect(updates).toHaveLength(0);
    expect(auditWrites).toHaveLength(0);
  });

  it('an unknown key is NOT FOUND — and another account’s key is unresolvable by scoping', async () => {
    const { prisma } = fakePrisma();
    await expect(
      build(prisma).updateConversationStatus({ key: 'ghost', agentName: 'X' }, md(ADMIN_PERMS)),
    ).rejects.toThrow(RpcException);
  });
});
