import { GroupService, normaliseName, MAX_GROUP_NAME_LENGTH } from './group.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * US1 (feature 024, roadmap 5.3 — ADR 0039). The group entity: it exists, it has an operator-chosen
 * name, it has members, and nothing about it crosses an account.
 *
 * The fake used here BEHAVES LIKE A DATABASE — the composite key really is idempotent, the delete
 * really cascades, and a duplicate name really throws a unique violation. That is a deliberate
 * response to feature 023, whose one genuine defect survived every unit test because a fake answers
 * whatever it was told. A fake that cannot fail proves nothing about idempotence or cascade.
 */
const ACTOR = { userId: 'admin-1' };
/**
 * What the acting administrator already holds. A caller may confer only keys from this set (FR-015 —
 * see `group-grant-parity.spec.ts`, which owns that rule); here it is simply "everything the fixtures
 * use", so these tests exercise the entity rather than the escalation guard.
 */
const HELD = ['crm.inbox.view', 'crm.contact.view', 'crm.invented.key'];

function make(seed: FakeSeed = {}) {
  const prisma = makeFakePrisma(seed) as unknown as PrismaService;
  const groups = new GroupService(prisma, new AuditRepository(prisma));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (prisma as any)._tables;
  return { groups, tables };
}

describe('GroupService — the entity and its membership', () => {
  it('creates a group, and the group is the only thing that changed', async () => {
    const { groups, tables } = make();
    const r = await groups.create('acct-1', ACTOR, 'Payments desk');

    expect(r.status).toBe('ok');
    expect(tables.groups).toHaveLength(1);
    expect(tables.groups[0].name).toBe('Payments desk');
    // Nobody's effective set moved: a brand-new group has no members and no grants, so there is
    // nothing for the gateway to invalidate. Returning a spurious id here would be a lie the cache
    // would act on.
    expect(r.status === 'ok' && r.affectedUserIds).toEqual([]);
  });

  it('trims the name before storing it', async () => {
    const { groups, tables } = make();
    await groups.create('acct-1', ACTOR, '  Payments desk \n');
    expect(tables.groups[0].name).toBe('Payments desk');
  });

  it('refuses a duplicate name — a collision is a NAMED refusal, not a 500', async () => {
    const { groups } = make({ groups: [{ name: 'Payments' }] });
    expect((await groups.create('acct-1', ACTOR, 'Payments')).status).toBe('name_taken');
  });

  it('refuses a duplicate that differs only by whitespace', async () => {
    // Two groups an administrator cannot tell apart are worse than refusing the second one.
    const { groups } = make({ groups: [{ name: 'Payments' }] });
    expect((await groups.create('acct-1', ACTOR, '  Payments  ')).status).toBe('name_taken');
  });

  it('survives losing the read-then-write race (the unique violation is caught)', async () => {
    // The fake throws P2002 exactly as Postgres would. Without the catch this test throws instead of
    // returning a status — which is the difference between a named refusal and a 500 under load.
    const { groups, tables } = make();
    await groups.create('acct-1', ACTOR, 'Payments');
    tables.groups[0].name = 'Payments'; // still there; simulate the concurrent winner
    expect((await groups.create('acct-1', ACTOR, 'Payments')).status).toBe('name_taken');
  });

  it.each([['', 'empty'], ['   ', 'whitespace only'], ['x'.repeat(MAX_GROUP_NAME_LENGTH + 1), 'too long']])(
    'refuses a name that is %s (%s)',
    async (name) => {
      const { groups } = make();
      expect((await groups.create('acct-1', ACTOR, name)).status).toBe('invalid_name');
    },
  );

  it('renames, and reports nobody as affected — a name is not an authorization input', async () => {
    const { groups, tables } = make({
      groups: [{ name: 'Old' }],
      users: [{ id: 'u-1' }],
      groupMembers: [{ groupName: 'Old', user_id: 'u-1' }],
    });
    const r = await groups.rename('acct-1', ACTOR, 'group-Old', 'New');
    expect(r.status).toBe('ok');
    expect(tables.groups[0].name).toBe('New');
    // Nothing branches on a group name (ADR 0039 §9), so no cached decision can be stale because of
    // one. Returning the members here would be invalidation theatre.
    expect(r.status === 'ok' && r.affectedUserIds).toEqual([]);
  });

  it('refuses a rename onto an existing name, but allows renaming a group to itself', async () => {
    const { groups } = make({ groups: [{ name: 'A' }, { name: 'B' }] });
    expect((await groups.rename('acct-1', ACTOR, 'group-A', 'B')).status).toBe('name_taken');
    expect((await groups.rename('acct-1', ACTOR, 'group-A', 'A')).status).toBe('ok');
  });

  it('adds a member, and the same person may belong to several groups at once', async () => {
    const { groups, tables } = make({
      groups: [{ name: 'A' }, { name: 'B' }],
      users: [{ id: 'u-1' }],
    });
    await groups.addMember('acct-1', ACTOR, 'group-A', 'u-1');
    await groups.addMember('acct-1', ACTOR, 'group-B', 'u-1');

    // ADR 0039 §Open item 4, assumed yes: the union model in §3 depends on it.
    expect(tables.groupMembers).toHaveLength(2);
    expect(await groups.listMembers('acct-1', 'group-A')).toEqual(['u-1']);
    expect(await groups.listMembers('acct-1', 'group-B')).toEqual(['u-1']);
  });

  it('adding an existing member cannot produce a second row', async () => {
    const { groups, tables } = make({
      groups: [{ name: 'A' }],
      users: [{ id: 'u-1' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
    });
    const r = await groups.addMember('acct-1', ACTOR, 'group-A', 'u-1');
    expect(r.status).toBe('ok');
    // Idempotence comes from the composite PRIMARY KEY, not from an application-level check — the
    // latter would be a race.
    expect(tables.groupMembers).toHaveLength(1);
  });

  it('removes a member, and removing an absent one is accepted rather than an error', async () => {
    const { groups, tables } = make({
      groups: [{ name: 'A' }],
      users: [{ id: 'u-1' }, { id: 'u-2' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
    });
    expect((await groups.removeMember('acct-1', ACTOR, 'group-A', 'u-1')).status).toBe('ok');
    expect(tables.groupMembers).toHaveLength(0);
    expect((await groups.removeMember('acct-1', ACTOR, 'group-A', 'u-2')).status).toBe('ok');
  });

  it('deletes a group: memberships and grants go, the STAFF do not', async () => {
    const { groups, tables } = make({
      groups: [{ name: 'A' }],
      users: [{ id: 'u-1' }, { id: 'u-2' }],
      permissions: [{ key: 'crm.inbox.view' }],
      groupMembers: [
        { groupName: 'A', user_id: 'u-1' },
        { groupName: 'A', user_id: 'u-2' },
      ],
      groupPermissions: [{ groupName: 'A', permKey: 'crm.inbox.view' }],
    });
    const r = await groups.remove('acct-1', ACTOR, 'group-A');

    expect(r.status).toBe('ok');
    expect(tables.groups).toHaveLength(0);
    expect(tables.groupMembers).toHaveLength(0);
    expect(tables.groupPermissions).toHaveLength(0);
    expect(tables.users).toHaveLength(2);
    // Everyone who was in it loses whatever the group conferred → every one of them must be
    // invalidated, and the list has to be read BEFORE the cascade removes it.
    expect(r.status === 'ok' && r.affectedUserIds.sort()).toEqual(['u-1', 'u-2']);
  });

  it('reports a missing group as not_found, and never touches anything', async () => {
    const { groups } = make({ users: [{ id: 'u-1' }] });
    expect((await groups.rename('acct-1', ACTOR, 'nope', 'x')).status).toBe('not_found');
    expect((await groups.remove('acct-1', ACTOR, 'nope')).status).toBe('not_found');
    expect((await groups.addMember('acct-1', ACTOR, 'nope', 'u-1')).status).toBe('not_found');
    expect(await groups.listMembers('acct-1', 'nope')).toBeNull();
  });

  it('refuses to add a user the account does not have', async () => {
    const { groups } = make({ groups: [{ name: 'A' }] });
    expect((await groups.addMember('acct-1', ACTOR, 'group-A', 'stranger')).status).toBe(
      'not_found',
    );
  });

  it('distinguishes "group has nobody" from "group does not exist"', async () => {
    // Both would be an empty pool to a naive routing caller; only one of them is a mistake.
    const { groups } = make({ groups: [{ name: 'Empty' }] });
    expect(await groups.listMembers('acct-1', 'group-Empty')).toEqual([]);
    expect(await groups.listMembers('acct-1', 'group-Absent')).toBeNull();
  });

  it('lists groups with their member count and their grants', async () => {
    const { groups } = make({
      groups: [{ name: 'A' }],
      users: [{ id: 'u-1' }],
      permissions: [{ key: 'crm.inbox.view' }, { key: 'crm.contact.view' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
      groupPermissions: [
        { groupName: 'A', permKey: 'crm.contact.view' },
        { groupName: 'A', permKey: 'crm.inbox.view' },
      ],
    });
    expect(await groups.list('acct-1')).toEqual([
      {
        id: 'group-A',
        name: 'A',
        active: true,
        memberCount: 1,
        permissionKeys: ['crm.contact.view', 'crm.inbox.view'],
      },
    ]);
  });
});

describe('GroupService — permission grants', () => {
  const seed: FakeSeed = {
    groups: [{ name: 'A' }],
    users: [{ id: 'u-1' }, { id: 'u-2' }],
    permissions: [{ key: 'crm.inbox.view' }],
    groupMembers: [
      { groupName: 'A', user_id: 'u-1' },
      { groupName: 'A', user_id: 'u-2' },
    ],
  };

  it('grants a catalogue key and names EVERY member as affected', async () => {
    const { groups, tables } = make(seed);
    const r = await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', true);

    expect(r.status).toBe('ok');
    expect(tables.groupPermissions).toHaveLength(1);
    // Missing one member here is the whole defect this field exists to prevent: their cached
    // effective set would keep the old answer for the length of the TTL.
    expect(r.status === 'ok' && r.affectedUserIds.sort()).toEqual(['u-1', 'u-2']);
  });

  it('granting twice is idempotent on the data', async () => {
    const { groups, tables } = make(seed);
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', true);
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', true);
    expect(tables.groupPermissions).toHaveLength(1);
  });

  it('revoking DELETES the grant — it does not store a denial', async () => {
    const { groups, tables } = make({
      ...seed,
      groupPermissions: [{ groupName: 'A', permKey: 'crm.inbox.view' }],
    });
    await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.inbox.view', false);
    // ADR 0039 §3: a group grants and never denies. There is no row left saying "not this one" —
    // the model cannot express it, and this asserts the service does not try.
    expect(tables.groupPermissions).toHaveLength(0);
  });

  it('refuses a key that is not in the catalogue', async () => {
    const { groups } = make(seed);
    expect(
      (await groups.setPermission('acct-1', ACTOR, HELD, 'group-A', 'crm.invented.key', true)).status,
    ).toBe('unknown_permission');
  });
});

describe('normaliseName', () => {
  it('trims, and rejects what is not a usable name', () => {
    expect(normaliseName('  a  ')).toBe('a');
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('   ')).toBeNull();
    expect(normaliseName(undefined)).toBeNull();
    expect(normaliseName('x'.repeat(MAX_GROUP_NAME_LENGTH))).toHaveLength(MAX_GROUP_NAME_LENGTH);
    expect(normaliseName('x'.repeat(MAX_GROUP_NAME_LENGTH + 1))).toBeNull();
  });
});
