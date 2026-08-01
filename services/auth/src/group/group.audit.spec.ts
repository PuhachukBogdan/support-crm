import { GroupService } from './group.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * FR-017 (feature 024) — **exactly one audit entry per accepted mutation. Never zero, never two.**
 *
 * Why every one of the seven is audited: adding someone to a group GRANTS ACCESS. That is the whole
 * premise of ADR 0039, and it is the same reason roadmap 5.7 attached an audit condition to
 * self-assignment. All seven are filed under the `privilege` class — including `group.delete`,
 * because what matters about a deletion is that every member LOSES the group's grants, not that a row
 * went away.
 *
 * Why a no-op still writes: adding someone who is already a member changes no row, but an
 * administrator still ACTED. Feature 015 left the audit table without a unique constraint for exactly
 * this reason — "a retry is a NEW act by the operator and deserves its own entry; two grant attempts,
 * one failed, is exactly what a reviewer needs to see."
 */
const ACTOR = { userId: 'admin-1' };
/** Keys the acting administrator holds — the no-escalation rule is exercised in its own spec. */
const HELD = ['crm.inbox.view', 'not.a.key'];

const BASE: FakeSeed = {
  groups: [{ name: 'A' }],
  users: [{ id: 'u-1' }, { id: 'u-2' }],
  permissions: [{ key: 'crm.inbox.view' }],
  groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
};

function make(seed: FakeSeed = BASE) {
  const prisma = makeFakePrisma(seed) as unknown as PrismaService;
  const groups = new GroupService(prisma, new AuditRepository(prisma));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = () => (prisma as any)._tables.auditEntries as { action: string; target_ref: string; detail_json: unknown }[];
  return { groups, entries };
}

describe('group mutations write exactly one audit entry each', () => {
  it('group.create', async () => {
    const { groups, entries } = make({});
    await groups.create('acct-1', ACTOR, 'New desk');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group.create');
  });

  it('group.rename', async () => {
    const { groups, entries } = make();
    await groups.rename('acct-1', ACTOR, 'group-A', 'B');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group.rename');
  });

  it('group.delete, carrying how many people it affected', async () => {
    const { groups, entries } = make();
    await groups.remove('acct-1', ACTOR, 'group-A');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group.delete');
    expect(entries()[0]!.detail_json).toMatchObject({ affectedCount: 1 });
  });

  it('group_member.add', async () => {
    const { groups, entries } = make();
    await groups.addMember('acct-1', ACTOR, 'group-A', 'u-2');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group_member.add');
  });

  it('group_member.remove', async () => {
    const { groups, entries } = make();
    await groups.removeMember('acct-1', ACTOR, 'group-A', 'u-1');
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group_member.remove');
  });

  it('group_permission.grant', async () => {
    const { groups, entries } = make();
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', true);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group_permission.grant');
    expect(entries()[0]!.detail_json).toMatchObject({ permissionKey: 'crm.inbox.view', grant: true });
  });

  it('group_permission.revoke', async () => {
    const { groups, entries } = make({
      ...BASE,
      groupPermissions: [{ groupName: 'A', permKey: 'crm.inbox.view' }],
    });
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', false);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]!.action).toBe('group_permission.revoke');
    expect(entries()[0]!.detail_json).toMatchObject({ grant: false });
  });

  it('a no-op add still records the act — the trail is of ATTEMPTS, not of row changes', async () => {
    const { groups, entries } = make();
    await groups.addMember('acct-1', ACTOR, 'group-A', 'u-1'); // already a member
    expect(entries()).toHaveLength(1);
  });

  it('a REFUSED mutation writes nothing', async () => {
    // "Exactly one per ACCEPTED request." A not-found is not an act against anything, and filing one
    // would let an attacker pad the trail by naming ids at random.
    const { groups, entries } = make();
    await groups.rename('acct-1', ACTOR, 'nope', 'x');
    await groups.addMember('acct-1', ACTOR, 'group-A', 'stranger');
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'not.a.key', true);
    await groups.create('acct-1', ACTOR, '   ');
    expect(entries()).toHaveLength(0);
  });

  it('every entry names the GROUP as its target, never the person', async () => {
    const { groups, entries } = make();
    await groups.addMember('acct-1', ACTOR, 'group-A', 'u-2');
    // `target_ref` identifies; the affected person is counted, not copied. The privilege detail
    // allow-list has no key that could carry a name or an address, which is why groups needed no
    // change to it at all.
    expect(entries()[0]!.target_ref).toBe('group-A');
  });

  it('records the acting administrator, and that they were under preview if they were', async () => {
    const { groups, entries } = make();
    await groups.addMember('acct-1', { userId: 'admin-9', underPreview: true }, 'group-A', 'u-2');
    // View-as is read-only, so this should never be true on a mutation. Recording it anyway means a
    // regression in that rule appears in the trail instead of being invisible (feature 015).
    expect(entries()[0]).toMatchObject({ actor_user_id: 'admin-9', under_preview: true });
  });
});
