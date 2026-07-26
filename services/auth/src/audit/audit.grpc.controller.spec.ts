import { Metadata } from '@grpc/grpc-js';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from './audit.repository';
import { AuditReadController } from './audit.grpc.controller';
import { AuditAccessGuard } from './audit.guard';
import { REQUIRED_AUDIT_PERMISSION_KEY } from './requires-audit-permission.decorator';

/**
 * T022 / T036 (feature 015, US1) — the audit read handler. FAILS before it exists, PASSES after.
 *
 * Beyond the permission gate, two behaviours carry weight:
 *  • an unrecognised filter is INVALID_ARGUMENT, not an unfiltered page (the feature-012 lesson);
 *  • reading the log writes exactly ONE `audit.read` entry, on the first page only. "Who went looking at who
 *    accessed what" is the same accountability question one level up, and an unaudited audit reader defeats
 *    the purpose — but recording it per page would inflate a sweep into an unreadable series.
 */
function md(perms: string[], accountId = 'acc-1', userId = 'god', preview = false): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-permissions', perms.join(','));
  if (preview) m.set('x-is-preview', 'true');
  return m;
}

const row = (id: string) => ({
  id,
  actor_user_id: 'god',
  actor_kind: 'user',
  actor_ref: null,
  under_preview: false,
  action: 'permission.grant',
  target_ref: 'u-1',
  detail_json: { scope: 'user' },
  created_at: new Date('2026-07-27T10:00:00Z'),
});

function build(rows: unknown[] = [row('a1')]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const create = jest.fn(async (a: unknown) => a);
  const scoped = { auditEntry: { findMany, create } };
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { ctrl: new AuditReadController(new AuditRepository(prisma)), findMany, create };
}

describe('the handler is permission-gated at the service tier', () => {
  it('declares platform.audit.view', () => {
    const required = new Reflector().get(
      REQUIRED_AUDIT_PERMISSION_KEY,
      AuditReadController.prototype.listAuditEntries as never,
    );
    expect(required).toBe('platform.audit.view');
  });

  it('the guard refuses a caller without the permission, independently of the gateway', () => {
    const guard = new AuditAccessGuard(new Reflector());
    const ctx = {
      getType: () => 'rpc',
      getHandler: () => AuditReadController.prototype.listAuditEntries,
      getClass: () => AuditReadController,
      switchToRpc: () => ({ getContext: () => md(['crm.inbox.view']) }),
    } as never;
    expect(() => guard.canActivate(ctx)).toThrow(RpcException);
  });

  it('the guard admits a caller who holds it', () => {
    const guard = new AuditAccessGuard(new Reflector());
    const ctx = {
      getType: () => 'rpc',
      getHandler: () => AuditReadController.prototype.listAuditEntries,
      getClass: () => AuditReadController,
      switchToRpc: () => ({ getContext: () => md(['platform.audit.view']) }),
    } as never;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('refuses a call with no account context (fail-closed)', async () => {
    const { ctrl } = build();
    const bare = new Metadata();
    bare.set('x-actor-permissions', 'platform.audit.view');
    await expect(ctrl.listAuditEntries({}, bare)).rejects.toBeInstanceOf(RpcException);
  });
});

describe('reading returns wire entries stamped with this source', () => {
  it('maps rows to the wire shape', async () => {
    const { ctrl } = build();
    const res = await ctrl.listAuditEntries({}, md(['platform.audit.view']));
    expect(res.entries[0]).toMatchObject({
      id: 'a1',
      action: 'permission.grant',
      actorKind: 'ACTOR_KIND_USER',
      source: 'auth',
      detailJson: JSON.stringify({ scope: 'user' }),
    });
  });

  it('clamps the page size', async () => {
    const { ctrl, findMany } = build();
    await ctrl.listAuditEntries({ pageSize: 5000 }, md(['platform.audit.view']));
    expect(findMany.mock.calls[0]![0].take).toBe(101); // 100 cap + 1 lookahead
  });
});

describe('an unrecognised filter is INVALID_ARGUMENT, never an unfiltered page', () => {
  it.each([
    { action: 'perm_grant' },
    { actionClass: 'everything' },
    { action: 'role.assign', actionClass: 'privilege' },
    { from: 'last tuesday' },
    { pageToken: 'garbage' },
  ])('refuses %p', async (req) => {
    const { ctrl, findMany } = build();
    await expect(ctrl.listAuditEntries(req, md(['platform.audit.view']))).rejects.toBeInstanceOf(
      RpcException,
    );
    // …and did not fall back to a broad query.
    if ('pageToken' in req || 'from' in req) return; // those fail inside list(), after the call is built
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('*** reading the log is itself recorded — once per read ***', () => {
  it('writes one audit.read entry on the first page', async () => {
    const { ctrl, create } = build();
    await ctrl.listAuditEntries({ action: 'permission.grant' }, md(['platform.audit.view']));

    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      action: 'audit.read',
      actor_user_id: 'god',
      target_ref: 'acc-1',
      // Which dimensions were filtered on — names only, never their values.
      detail_json: { filters: ['action'] },
    });
  });

  it('does NOT write another entry for a subsequent page', async () => {
    const { ctrl, create } = build();
    await ctrl.listAuditEntries(
      { pageToken: Buffer.from('["2026-07-27T10:00:00.000Z","a1"]').toString('base64url') },
      md(['platform.audit.view']),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('records the real actor plus the preview marker', async () => {
    const { ctrl, create } = build();
    await ctrl.listAuditEntries({}, md(['platform.audit.view'], 'acc-1', 'god', true));
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actor_user_id).toBe('god');
    expect(data.under_preview).toBe(true);
  });

  it('records the filter NAMES only, never their values', async () => {
    const { ctrl, create } = build();
    await ctrl.listAuditEntries(
      { actorUserId: 'someone-specific', targetRef: 'player-42' },
      md(['platform.audit.view']),
    );
    const serialized = JSON.stringify(
      (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data.detail_json,
    );
    expect(serialized).toContain('actorUserId');
    expect(serialized).toContain('targetRef');
    expect(serialized).not.toContain('someone-specific');
    expect(serialized).not.toContain('player-42');
  });

  // Strict, like every other v1 class: if we cannot record that someone read the trail, we do not show them
  // the trail (spec Q3).
  it('a failing audit.read write fails the read', async () => {
    const findMany = jest.fn().mockResolvedValue([row('a1')]);
    const create = jest.fn().mockRejectedValue(new Error('audit down'));
    const prisma = {
      forAccount: () => ({ auditEntry: { findMany, create } }),
    } as unknown as PrismaService;
    const ctrl = new AuditReadController(new AuditRepository(prisma));
    await expect(ctrl.listAuditEntries({}, md(['platform.audit.view']))).rejects.toThrow('audit down');
  });
});
