import { RbacResolverService } from './resolver.service';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * US2 (feature 024, roadmap 5.3 — ADR 0039 §2). The group term enters the **one** resolver.
 *
 * This spec is the proof that FR-009 is satisfied where it says it must be: not "a group grant is
 * honoured somewhere", but "a group grant is computed in the SAME PLACE as role defaults and user
 * overrides". Every case below calls the same `resolve` the gateway calls on a cache miss and that
 * every service guard ultimately consumes through `x-actor-permissions`.
 *
 * The four exits and what each does with the term are the subject; getting any of them wrong is a
 * silent authorization change, which is why they are enumerated rather than sampled.
 */
const INBOX = 'crm.inbox.view';
const PII = 'crm.contact.read_pii';
const SMS = 'crm.sms.send';

function resolver(seed: FakeSeed) {
  return new RbacResolverService(makeFakePrisma(seed) as unknown as PrismaService);
}

const CATALOGUE = [{ key: INBOX }, { key: PII }, { key: SMS }];

describe('resolve — the group term (feature 024)', () => {
  it('INHERITED: role defaults ∪ the group’s grants', async () => {
    const r = await resolver({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      rolePermissions: [{ roleKey: 'support_agent', permKey: INBOX }],
      groups: [{ name: 'VIP' }],
      groupMembers: [{ groupName: 'VIP', user_id: 'u-1' }],
      groupPermissions: [{ groupName: 'VIP', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(r.permissionKeys.sort()).toEqual([PII, INBOX].sort());
    expect(r.roleKey).toBe('support_agent');
    expect(r.mode).toBe('inherited');
  });

  it('STANDALONE: the personalised snapshot ∪ the group’s grants — the subtle one', async () => {
    // FR-011. Personalising someone's permissions is copy-on-write over THEIR OWN set; it says
    // nothing about which unit they work in. Dropping the term here would silently remove access
    // from every person who has ever been individually edited — a permission change nobody made.
    const r = await resolver({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      userPermissionSets: [{ user_id: 'u-1', mode: 'standalone' }],
      userPermissionEntries: [{ user_id: 'u-1', permKey: INBOX }],
      groups: [{ name: 'VIP' }],
      groupMembers: [{ groupName: 'VIP', user_id: 'u-1' }],
      groupPermissions: [{ groupName: 'VIP', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(r.mode).toBe('standalone');
    expect(r.permissionKeys.sort()).toEqual([PII, INBOX].sort());
  });

  it('the standalone snapshot stays FROZEN while the group term stays LIVE', async () => {
    // Deliberate asymmetry, recorded so nobody "fixes" it: a membership is an ongoing fact, not
    // something handed over once. Here the role gained a key AFTER the snapshot — the standalone user
    // must NOT pick it up — while the group's key applies immediately.
    const r = await resolver({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      rolePermissions: [{ roleKey: 'support_agent', permKey: SMS }], // added to the template later
      userPermissionSets: [{ user_id: 'u-1', mode: 'standalone' }],
      userPermissionEntries: [{ user_id: 'u-1', permKey: INBOX }], // the frozen copy
      groups: [{ name: 'VIP' }],
      groupMembers: [{ groupName: 'VIP', user_id: 'u-1' }],
      groupPermissions: [{ groupName: 'VIP', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(r.permissionKeys).toContain(INBOX); // the snapshot
    expect(r.permissionKeys).toContain(PII); // live, from the group
    expect(r.permissionKeys).not.toContain(SMS); // the role template did NOT propagate
  });

  it('TWO groups union without duplicates', async () => {
    const r = await resolver({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      rolePermissions: [{ roleKey: 'support_agent', permKey: INBOX }],
      groups: [{ name: 'A' }, { name: 'B' }],
      groupMembers: [
        { groupName: 'A', user_id: 'u-1' },
        { groupName: 'B', user_id: 'u-1' },
      ],
      groupPermissions: [
        { groupName: 'A', permKey: PII },
        { groupName: 'B', permKey: PII }, // the same key from two groups
        { groupName: 'B', permKey: SMS },
      ],
    }).resolve('acct-1', 'u-1');

    // Duplication is not cosmetic here: the seed's "restricts nothing" check and the widen-only proof
    // both compare effective SETS, and a repeated key would read as a difference that is not one.
    expect(r.permissionKeys.sort()).toEqual([INBOX, PII, SMS].sort());
  });

  it('NO ROLE but a group: exactly what the group grants', async () => {
    // Deny-by-default still holds — the union of nothing and something is something, and treating
    // "no role" as a hard empty would be a second rule about who may do what.
    const r = await resolver({
      users: [{ id: 'u-1' }],
      permissions: CATALOGUE,
      groups: [{ name: 'A' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
      groupPermissions: [{ groupName: 'A', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(r.roleKey).toBe('');
    expect(r.permissionKeys).toEqual([PII]);
  });

  it('NO ROLE and no group is still the empty set (FR-012 unchanged)', async () => {
    const r = await resolver({ users: [{ id: 'u-1' }], permissions: CATALOGUE }).resolve(
      'acct-1',
      'u-1',
    );
    expect(r.permissionKeys).toEqual([]);
  });

  it('a group with no grants changes nothing', async () => {
    // The go-live configuration (ADR 0039 §7): the capability to restrict ships, nothing restricts.
    const r = await resolver({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      rolePermissions: [{ roleKey: 'support_agent', permKey: INBOX }],
      groups: [{ name: 'A' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
    }).resolve('acct-1', 'u-1');

    expect(r.permissionKeys).toEqual([INBOX]);
  });

  it('another person’s group grants NEVER leak', async () => {
    const r = await resolver({
      users: [{ id: 'u-1' }, { id: 'u-2' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: CATALOGUE,
      rolePermissions: [{ roleKey: 'support_agent', permKey: INBOX }],
      groups: [{ name: 'VIP' }],
      groupMembers: [{ groupName: 'VIP', user_id: 'u-2' }],
      groupPermissions: [{ groupName: 'VIP', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(r.permissionKeys).toEqual([INBOX]);
  });

  it('PREVIEW (view-as) does NOT include the previewing person’s group grants', async () => {
    // FR-012. The preview answers "what can this ROLE do?". Folding in the caller's own memberships
    // would make it report more access than the previewed role actually has — the one question it
    // exists to answer correctly.
    const r = await resolver({
      users: [{ id: 'admin-1' }],
      userRoles: [{ user_id: 'admin-1', roleKey: 'admin' }],
      permissions: CATALOGUE,
      roles: [{ key: 'support_agent' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: INBOX }],
      groups: [{ name: 'VIP' }],
      groupMembers: [{ groupName: 'VIP', user_id: 'admin-1' }],
      groupPermissions: [{ groupName: 'VIP', permKey: PII }],
    }).resolve('acct-1', 'admin-1', 'support_agent');

    expect(r.isPreview).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.permissionKeys).toEqual([INBOX]);
    expect(r.permissionKeys).not.toContain(PII);
  });

  it('⭐ the shape names the TERMS for the admin grid — and the union stays the only enforcement fact', async () => {
    /**
     * AMENDED BY W28 (9.8), deliberately. The 024 guard here pinned "a consumer cannot tell where a
     * key came from" — its fear was a GUARD growing an opinion about provenance (the second policy
     * layer ADR 0039 §2 forbids). W28's Access-Management grid needs provenance for EDITING, not
     * enforcing: a key granted via a group must render as «via group», or its toggle springs back
     * and reads as broken. So the shape gains exactly the two terms — and the enforcement rule
     * survives in a sharper form: `permissionKeys` (the union) remains the only field a guard may
     * read; `hasPermission` still takes one flat list and nothing else.
     */
    const r = await resolver({
      users: [{ id: 'u-1' }],
      permissions: CATALOGUE,
      groups: [{ name: 'A' }],
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
      groupPermissions: [{ groupName: 'A', permKey: PII }],
    }).resolve('acct-1', 'u-1');

    expect(Object.keys(r).sort()).toEqual(
      [
        'isPreview',
        'mode',
        'permissionKeys',
        'readOnly',
        'roleKey',
        'groupPermissionKeys',
        'basePermissionKeys',
      ].sort(),
    );
    // The terms say what the union already enforces — never more: union === base ∪ group.
    expect([...r.permissionKeys].sort()).toEqual(
      [...new Set([...r.basePermissionKeys, ...r.groupPermissionKeys])].sort(),
    );
    expect(r.groupPermissionKeys).toEqual([PII]);
  });
});
