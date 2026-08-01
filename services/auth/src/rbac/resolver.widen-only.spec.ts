import { RbacResolverService } from './resolver.service';
import { SYSTEM_CATALOGUE, ROLE_DEFAULTS, ROLE_KEYS } from './catalogue';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * FR-010 (feature 024, ADR 0039 §3) — **a group grants and never denies**, proven EXHAUSTIVELY over
 * the real catalogue rather than on a sampled key or two.
 *
 * Exhaustive on purpose. "Widen-only" is not a property of one grant; it is a property of the
 * resolver over every key and every role. A sampled version would keep passing while a future edit
 * introduced a subtraction for one particular key — and a permission that quietly disappears is
 * discovered by the person who could not do their job, not by a test.
 *
 * This is also what keeps ADR 0034's open item 1 ("does deny override allow?") genuinely open. If a
 * group could take something away, that question would have been answered by accident, in a corner of
 * the group model, by whoever wired the column.
 */
const ALL_KEYS = SYSTEM_CATALOGUE.map((e) => e.key);
const CATALOGUE = SYSTEM_CATALOGUE.map((e) => ({ key: e.key, category: e.category }));

function seedFor(roleKey: string, groupKeys: string[], standalone: boolean): FakeSeed {
  const roleKeys = ROLE_DEFAULTS[roleKey] ?? [];
  return {
    users: [{ id: 'u-1' }],
    userRoles: [{ user_id: 'u-1', roleKey }],
    permissions: CATALOGUE,
    rolePermissions: roleKeys.map((permKey) => ({ roleKey, permKey })),
    ...(standalone
      ? {
          userPermissionSets: [{ user_id: 'u-1', mode: 'standalone' }],
          userPermissionEntries: roleKeys.map((permKey) => ({ user_id: 'u-1', permKey })),
        }
      : {}),
    groups: [{ name: 'G' }],
    groupMembers: [{ groupName: 'G', user_id: 'u-1' }],
    groupPermissions: groupKeys.map((permKey) => ({ groupName: 'G', permKey })),
  };
}

async function effective(seed: FakeSeed): Promise<string[]> {
  const r = await new RbacResolverService(
    makeFakePrisma(seed) as unknown as PrismaService,
  ).resolve('acct-1', 'u-1');
  return r.permissionKeys;
}

describe('a group can only WIDEN an effective set (exhaustive)', () => {
  it('proves the fixtures are real — the catalogue is not empty and every role resolves', async () => {
    // Anti-vacuous: without this, every assertion below would pass just as happily over nothing.
    expect(ALL_KEYS.length).toBeGreaterThan(10);
    expect(ROLE_KEYS.length).toBeGreaterThanOrEqual(6);
    for (const roleKey of ROLE_KEYS) {
      expect((await effective(seedFor(roleKey, [], false))).length).toBeGreaterThan(0);
    }
  });

  describe.each(ROLE_KEYS)('role %s', (roleKey) => {
    it.each([
      ['inherited', false],
      ['standalone', true],
    ])('%s: adding EVERY catalogue key via a group only adds', async (_mode, standalone) => {
      const without = await effective(seedFor(roleKey, [], standalone as boolean));
      const withAll = await effective(seedFor(roleKey, ALL_KEYS, standalone as boolean));
      // Superset in both directions of the claim: nothing lost, and the union really is the whole
      // catalogue once every key is granted.
      for (const key of without) expect(withAll).toContain(key);
      expect(withAll.sort()).toEqual([...ALL_KEYS].sort());
    });

    it.each(ALL_KEYS)(`%s granted through a group never removes anything (${roleKey})`, async (key) => {
      const without = await effective(seedFor(roleKey, [], false));
      const withOne = await effective(seedFor(roleKey, [key], false));
      for (const held of without) expect(withOne).toContain(held);
      expect(withOne).toContain(key);
      // And it adds AT MOST that one key — a group must not pull in anything it was not granted.
      expect(withOne.length).toBeLessThanOrEqual(without.length + 1);
    });
  });

  it('there is no expressible way to write a negative grant', async () => {
    // The structural half lives in tests/data-model/group-grant-is-positive-only.spec.ts (the column
    // does not exist). This is the behavioural half: the service's only lever is presence/absence, so
    // "revoking" a key the role grants leaves the person holding it.
    const roleKey = 'support_agent';
    const held = ROLE_DEFAULTS[roleKey]![0]!;
    const viaGroup = await effective(seedFor(roleKey, [held], false));
    expect(viaGroup).toContain(held);
    const withoutGroupGrant = await effective(seedFor(roleKey, [], false));
    expect(withoutGroupGrant).toContain(held);
  });
});
