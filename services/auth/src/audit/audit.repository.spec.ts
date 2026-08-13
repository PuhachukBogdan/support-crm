import { encodeEntryCursor } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { AuditFilterError, AuditRepository } from './audit.repository';

/**
 * T021 (feature 015, US1) — the audit repository. FAILS before it exists, PASSES after.
 *
 * Three things are worth asserting beyond "it queries the table":
 *  • every operation goes through `forAccount` — including the writes, which have callers but whose entries
 *    describe privileged acts, so a scoping mistake here would let one tenant read another's accountability
 *    record;
 *  • filters are pushed INTO the query rather than applied after, so the federated merge never receives rows
 *    it will discard (and a page is never silently short);
 *  • an unrecognised filter is REFUSED. Dropping it would widen the query to everything and look like a
 *    successful search — the feature-012 lesson, and worse here than anywhere: "no entries for that user"
 *    would then be indistinguishable from "I mistyped the filter".
 */
function fake(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const create = jest.fn(async (a: unknown) => a);
  const scoped = { auditEntry: { findMany, create } };
  const forAccount = jest.fn(() => scoped);
  return { prisma: { forAccount } as unknown as PrismaService, findMany, create, forAccount };
}

const row = (id: string, createdAt: string) => ({
  id,
  actor_user_id: 'god',
  actor_kind: 'user',
  actor_ref: null,
  under_preview: false,
  action: 'permission.grant',
  target_ref: 'u-1',
  detail_json: { scope: 'user' },
  created_at: new Date(createdAt),
});

describe('append / statement — account-scoped, validated before the write', () => {
  it('append stamps the account and the validated entry', async () => {
    const { prisma, create, forAccount } = fake();
    await new AuditRepository(prisma).append('acc-1', {
      action: 'audit.read',
      actorUserId: 'god',
      targetRef: 'acc-1',
      detail: { filters: ['action'] },
    });
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    const data = (create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      account_id: 'acc-1',
      action: 'audit.read',
      actor_user_id: 'god',
      actor_kind: 'user',
      under_preview: false,
      detail_json: { filters: ['action'] },
    });
  });

  // Validation happens when the statement is BUILT, so a bad entry stops the action before its transaction
  // opens — a refusal means nothing was attempted, not that something was rolled back.
  it('statement refuses an unknown action before any transaction can start', () => {
    const { prisma, create } = fake();
    expect(() =>
      new AuditRepository(prisma).statement('acc-1', {
        action: 'perm_grant' as never,
        actorUserId: 'god',
        targetRef: 'u-1',
      }),
    ).toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('statement refuses an inexpressible detail', () => {
    const { prisma } = fake();
    expect(() =>
      new AuditRepository(prisma).statement('acc-1', {
        action: 'automation.delete',
        actorUserId: 'god',
        targetRef: 'a-1',
        detail: { name: 'someone@example.test' },
      }),
    ).toThrow();
  });

  it('refuses an entry with no actor, and a system actor with no rule reference', () => {
    const repo = new AuditRepository(fake().prisma);
    expect(() =>
      repo.statement('acc-1', { action: 'audit.read', actorUserId: '', targetRef: 'acc-1' }),
    ).toThrow();
    expect(() =>
      repo.statement('acc-1', {
        action: 'automation.delete',
        actorUserId: '',
        actorKind: 'system',
        targetRef: 'a-1',
      }),
    ).toThrow();
  });
});

describe('list — ordering, paging, and pushed-down filters', () => {
  it('orders newest-first with id as the tie-break', async () => {
    const { prisma, findMany } = fake([row('a', '2026-07-27T10:00:00Z')]);
    await new AuditRepository(prisma).list('acc-1', {}, 50);
    expect(findMany.mock.calls[0]![0].orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
  });

  it('is account-scoped', async () => {
    const { prisma, forAccount } = fake();
    await new AuditRepository(prisma).list('acc-9', {}, 50);
    expect(forAccount).toHaveBeenCalledWith('acc-9');
  });

  it('pushes actor and target into the query', async () => {
    const { prisma, findMany } = fake();
    await new AuditRepository(prisma).list('acc-1', { actorUserId: 'god', targetRef: 'u-1' }, 50);
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ actor_user_id: 'god', target_ref: 'u-1' });
  });

  it('expands a CLASS filter into its actions', async () => {
    const { prisma, findMany } = fake();
    await new AuditRepository(prisma).list('acc-1', { actionClass: 'privilege' }, 50);
    const where = findMany.mock.calls[0]![0].where as { action: { in: string[] } };
    // Spelled out rather than derived from `actionsOfClass`, deliberately: this assertion exists so
    // that widening a class is a VISIBLE edit. Deriving it would make the test agree with whatever
    // the catalogue happens to say, which is what it is meant to check.
    expect(where.action.in.sort()).toEqual(
      [
        'permission.grant',
        'permission.reset',
        'permission.revoke',
        'role.assign',
        'role.revoke',
        // Feature 024 (roadmap 5.3): a group change IS a privilege change — adding someone to a group
        // grants access — so "show me every permission change" must return these too.
        'group.create',
        'group.rename',
        // Feature 031 (ADR 0042): switching a desk into automatic distribution. A DISTINCT action
        // rather than part of `group.rename`, because it changes who receives customer conversations
        // without anybody choosing — and this hardcoded list is what caught the addition.
        'group.routability_changed',
        'group.delete',
        'group_member.add',
        'group_member.remove',
        'group_permission.grant',
        'group_permission.revoke',
        // Feature 025 (roadmap 5.9): an administrator overriding somebody else's presence. It grants
        // no permission, but it redirects the work the system gives a named person without their
        // involvement — so "show me every privilege change" must surface it too.
        'presence.override',
      ].sort(),
    );
  });

  it('applies a time range as gte/lt', async () => {
    const { prisma, findMany } = fake();
    await new AuditRepository(prisma).list(
      'acc-1',
      { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' },
      50,
    );
    const where = findMany.mock.calls[0]![0].where as { created_at: { gte: Date; lt: Date } };
    expect(where.created_at.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(where.created_at.lt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('applies a keyset cursor as a strict "older than" predicate', async () => {
    const { prisma, findMany } = fake();
    await new AuditRepository(prisma).list(
      'acc-1',
      {},
      50,
      encodeEntryCursor({ createdAt: '2026-07-27T10:00:00.000Z', id: 'x' }),
    );
    expect(findMany.mock.calls[0]![0].where.OR).toHaveLength(2);
  });

  it('returns a token only when there is more, and never a total', async () => {
    const many = Array.from({ length: 3 }, (_, i) => row(`r${i}`, `2026-07-27T1${i}:00:00Z`));
    const { prisma } = fake(many);
    const res = await new AuditRepository(prisma).list('acc-1', {}, 2);
    expect(res.rows).toHaveLength(2);
    expect(res.nextPageToken).not.toBe('');

    const { prisma: p2 } = fake(many.slice(0, 2));
    const res2 = await new AuditRepository(p2).list('acc-1', {}, 2);
    expect(res2.nextPageToken).toBe('');
  });
});

describe('list — an unrecognised filter is refused, never ignored', () => {
  it.each(['perm_grant', 'permission.granted', 'PERMISSION.GRANT'])(
    'refuses the unknown action %p',
    async (action) => {
      const { prisma, findMany } = fake();
      await expect(new AuditRepository(prisma).list('acc-1', { action }, 50)).rejects.toBeInstanceOf(
        AuditFilterError,
      );
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('refuses an unknown class', async () => {
    const { prisma } = fake();
    await expect(
      new AuditRepository(prisma).list('acc-1', { actionClass: 'everything' }, 50),
    ).rejects.toBeInstanceOf(AuditFilterError);
  });

  it('refuses action AND class together (they would contradict)', async () => {
    const { prisma } = fake();
    await expect(
      new AuditRepository(prisma).list('acc-1', { action: 'role.assign', actionClass: 'privilege' }, 50),
    ).rejects.toBeInstanceOf(AuditFilterError);
  });

  it('refuses an unparseable timestamp', async () => {
    const { prisma } = fake();
    await expect(
      new AuditRepository(prisma).list('acc-1', { from: 'last tuesday' }, 50),
    ).rejects.toBeInstanceOf(AuditFilterError);
  });

  it('refuses a malformed page token rather than scanning from the top', async () => {
    const { prisma } = fake();
    await expect(new AuditRepository(prisma).list('acc-1', {}, 50, 'garbage')).rejects.toThrow();
  });
});
