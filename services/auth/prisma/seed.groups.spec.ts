import { buildSeed } from './seed.build';
import { RbacResolverService } from '../src/rbac/resolver.service';
import { SYSTEM_CATALOGUE, ROLE_DEFAULTS, ROLE_KEYS } from '../src/rbac/catalogue';
import type { PrismaService } from '../src/prisma.service';
import { makeFakePrisma, type FakeSeed } from '../tests/support/auth-test-doubles';

/**
 * FR-027 (feature 024, roadmap 5.3 — ADR 0039 §7) — **the shipped configuration restricts nothing.**
 *
 * ⚠️ **This is a SET COMPARISON, deliberately, and the distinction is the whole value of the test.**
 * The easy version — "no `groupPermissions` rows appear in the seed file" — passes vacuously: it also
 * passes if the seed has no groups, if the resolver ignores groups entirely, or if the array is
 * renamed. What the operator actually needs to be true is that *nobody's access changed*, and the
 * only way to assert that is to resolve the effective set twice, with the memberships and without,
 * and require them to be identical.
 *
 * Why it matters that this is asserted rather than assumed: the capability to restrict now exists,
 * and the difference between "we shipped it open" and "we shipped it closed" is invisible in a diff.
 * ADR 0038 removed brand machinery that had been dead for four phases because nobody checked whether
 * it was on. This is the check.
 */
const seed = buildSeed();
const CATALOGUE = SYSTEM_CATALOGUE.map((e) => ({ key: e.key, category: e.category }));

/** Translate the seed's real ids into the fake's readable-handle fixtures. */
function fixture(withGroups: boolean): FakeSeed {
  const groupNameById = new Map(seed.groups.map((g) => [g.id, g.name]));
  const permKeyById = new Map(seed.permissions.map((p) => [p.id, p.key]));
  const roleKeyById = new Map(seed.roles.map((r) => [r.id, r.key]));
  return {
    users: seed.users.map((u) => ({ id: u.id, account_id: u.account_id })),
    userRoles: seed.userRoles.map((ur) => ({
      user_id: ur.user_id,
      roleKey: roleKeyById.get(ur.role_id)!,
    })),
    permissions: CATALOGUE,
    rolePermissions: seed.rolePermissions.map((rp) => ({
      roleKey: roleKeyById.get(rp.role_id)!,
      permKey: permKeyById.get(rp.permission_id)!,
    })),
    ...(withGroups
      ? {
          groups: seed.groups.map((g) => ({ name: g.name })),
          groupMembers: seed.groupMembers.map((m) => ({
            groupName: groupNameById.get(m.group_id)!,
            user_id: m.user_id,
          })),
          groupPermissions: seed.groupPermissions.map((gp) => ({
            groupName: groupNameById.get(gp.group_id)!,
            permKey: permKeyById.get(gp.permission_id)!,
          })),
        }
      : {}),
  };
}

const resolve = async (withGroups: boolean, userId: string) =>
  (
    await new RbacResolverService(
      makeFakePrisma(fixture(withGroups)) as unknown as PrismaService,
    ).resolve('acct-1', userId)
  ).permissionKeys
    .slice()
    .sort();

describe('the seeded configuration restricts nothing (FR-027)', () => {
  it('the fixtures are real — there ARE seeded groups with members', () => {
    // Anti-vacuous. Without this, the comparison below would hold trivially over an empty seed.
    expect(seed.groups.length).toBeGreaterThanOrEqual(2);
    expect(seed.groupMembers.length).toBeGreaterThanOrEqual(3);
    expect(seed.users.length).toBeGreaterThanOrEqual(4);
  });

  it('a seeded member’s effective set is IDENTICAL with and without their memberships', async () => {
    const members = [...new Set(seed.groupMembers.map((m) => m.user_id))];
    expect(members.length).toBeGreaterThan(0);
    for (const userId of members) {
      expect(await resolve(true, userId)).toEqual(await resolve(false, userId));
    }
  });

  it('every seeded user resolves to exactly their role’s template — no more, no less', async () => {
    const roleKeyById = new Map(seed.roles.map((r) => [r.id, r.key]));
    for (const ur of seed.userRoles) {
      const roleKey = roleKeyById.get(ur.role_id)!;
      expect(await resolve(true, ur.user_id)).toEqual([...ROLE_DEFAULTS[roleKey]!].sort());
    }
  });

  it('the seed grants nothing through a group, and the loop that would is still there', () => {
    // The array being empty is the claim; the runner's upsert loop existing is what makes granting
    // something later a DATA change rather than a code change.
    expect(seed.groupPermissions).toEqual([]);
  });

  it('⭐ feature 031: exactly ONE seeded desk is routable, and the other is the refusal fixture', () => {
    // Not "at least one": a seed that marked every desk routable would make the DESK_NOT_ROUTABLE path
    // unreachable on the stand, and that path is the default for every real deployment.
    const routable = seed.groups.filter((g) => g.routable);
    expect(routable).toHaveLength(1);
    expect(seed.groups.filter((g) => !g.routable)).toHaveLength(1);
  });

  it('no seeded group name is one the operator’s current system uses (ADR 0039 §9)', () => {
    for (const g of seed.groups) {
      for (const real of ['Support', 'VIP', 'Deposit requests', 'Directa24', 'PayCord']) {
        expect(g.name).not.toContain(real);
      }
    }
  });

  it('the seeded roles still cover the whole catalogue between them (nothing was dropped)', () => {
    const granted = new Set(ROLE_KEYS.flatMap((k) => [...ROLE_DEFAULTS[k]!]));
    for (const entry of SYSTEM_CATALOGUE) expect(granted.has(entry.key)).toBe(true);
  });
});
