import { of } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GroupsController } from './groups.controller';
import type { EffectivePermsCache } from '../security/effective-perms.cache';

/**
 * The groups edge (feature 024, roadmap 5.3). Two things are under test and only one of them is
 * plumbing.
 *
 * The plumbing: caller identity comes from the validated claims, and each group status maps to its
 * own HTTP answer rather than to one generic failure.
 *
 * ⚠️ **The part that matters: INVALIDATION.** `EffectivePermsCache` holds a resolved permission set
 * for 30 seconds and depends entirely on explicit invalidation. When a grant is revoked from a group,
 * every MEMBER's cache must be dropped — not just the caller's, and not just the one person named in
 * the request. Getting that wrong means a revoked permission keeps working for up to half a minute,
 * which is an authorization defect wearing a freshness costume.
 *
 * This spec can only prove the edge asks. That the answer actually changes on the next request is
 * Track B (B2 → B3), with its positive control written first — an offline test cannot fail on a real
 * TTL it does not have.
 */
const CLAIMS = { accountId: 'acct-1', userId: 'admin-1', roles: ['admin'] };
const req = () => ({ claims: CLAIMS }) as never;

function make(mutation: Partial<Record<string, unknown>> = {}) {
  const invalidate = jest.fn(async () => undefined);
  const cache = { invalidate } as unknown as EffectivePermsCache;
  const wire = {
    status: 'GROUP_STATUS_OK',
    message: '',
    affectedUserIds: [],
    groupId: 'g-1',
    ...mutation,
  };
  const auth = {
    listGroups: jest.fn(() => of({ groups: [] })),
    createGroup: jest.fn(() => of(wire)),
    renameGroup: jest.fn(() => of(wire)),
    deleteGroup: jest.fn(() => of(wire)),
    addGroupMember: jest.fn(() => of(wire)),
    removeGroupMember: jest.fn(() => of(wire)),
    listGroupMembers: jest.fn(() => of({ userIds: ['u-1'] })),
    setGroupPermission: jest.fn(() => of(wire)),
    setGroupRoutable: jest.fn(() => of(wire)),
  };
  const client = { getService: () => auth } as never;
  const c = new GroupsController(client, cache);
  c.onModuleInit();
  return { c, auth, invalidate };
}

describe('GroupsController — invalidation is the feature', () => {
  it('revoking a grant invalidates EVERY member, not only the caller', async () => {
    const { c, invalidate } = make({ affectedUserIds: ['u-1', 'u-2', 'u-3'] });
    await c.revoke('g-1', 'crm.contact.read_pii', req());
    expect(invalidate).toHaveBeenCalledTimes(3);
    for (const uid of ['u-1', 'u-2', 'u-3']) {
      expect(invalidate).toHaveBeenCalledWith('acct-1', uid);
    }
    // The caller is NOT special here — they are invalidated only if they are a member. Invalidating
    // the caller instead of the members is the plausible wrong implementation.
    expect(invalidate).not.toHaveBeenCalledWith('acct-1', 'admin-1');
  });

  it('removing a member invalidates that member', async () => {
    const { c, invalidate } = make({ affectedUserIds: ['u-9'] });
    await c.removeMember('g-1', 'u-9', req());
    expect(invalidate).toHaveBeenCalledWith('acct-1', 'u-9');
  });

  it('deleting a group invalidates everyone who was in it', async () => {
    const { c, invalidate } = make({ affectedUserIds: ['u-1', 'u-2'] });
    await c.remove('g-1', req());
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('creating and renaming invalidate nobody', async () => {
    // A name is not an authorization input, and a new group has no members. Invalidating here would
    // be theatre — and theatre is how a real invalidation later gets assumed to be happening.
    const { c, invalidate } = make({ affectedUserIds: [] });
    await c.create({ name: 'Payments' }, req());
    await c.rename('g-1', { name: 'Payments 2' }, req());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a FAILED mutation invalidates nothing', async () => {
    const { c, invalidate } = make({ status: 'GROUP_STATUS_NOT_FOUND', affectedUserIds: ['u-1'] });
    await expect(c.remove('nope', req())).rejects.toBeInstanceOf(NotFoundException);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('the invalidation is AWAITED before the reply', async () => {
    // A caller that receives 200 and immediately re-reads must not be served the pre-change answer.
    let resolved = false;
    const invalidate = jest.fn(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            resolved = true;
            r();
          }, 5),
        ),
    );
    const auth = {
      setGroupPermission: () =>
        of({ status: 'GROUP_STATUS_OK', message: '', affectedUserIds: ['u-1'], groupId: 'g-1' }),
    };
    const c = new GroupsController(
      { getService: () => auth } as never,
      { invalidate } as unknown as EffectivePermsCache,
    );
    c.onModuleInit();
    await c.grant('g-1', 'crm.inbox.view', req());
    expect(resolved).toBe(true);
  });
});

describe('⭐ marking a desk routable (feature 031, roadmap 4.20)', () => {
  it('PUT asks for routable, DELETE asks for not-routable — the verb carries the value', async () => {
    const { c, auth } = make();
    await c.markRoutable('g-1', req());
    await c.unmarkRoutable('g-1', req());
    const calls = (auth.setGroupRoutable as jest.Mock).mock.calls.map((c2) => c2[0].routable);
    expect(calls).toEqual([true, false]);
  });

  it('caller identity comes from the CLAIMS, like every other group mutation', async () => {
    const { c, auth } = make();
    await c.markRoutable('g-1', req());
    expect((auth.setGroupRoutable as jest.Mock).mock.calls[0][0]).toMatchObject({
      callerAccountId: 'acct-1',
      callerUserId: 'admin-1',
      groupId: 'g-1',
    });
  });

  it('⚠️ invalidates NOBODY — routability is not a permission', async () => {
    // Deciding which desks receive pushed work changes what the router does, not what anybody may see.
    // Dropping caches here would be harmless and misleading: it would suggest this flag is an access
    // control, and the next reader would look for the authorization it does not carry.
    // The receipt is upstream: `setRoutable` answers `affectedUserIds: []` on purpose, so the shared
    // `finish()` has nobody to invalidate. Asserted with the default fixture (an empty list) rather than
    // by mocking a non-empty one, because the empty list IS the claim.
    const { c, invalidate, auth } = make();
    await c.markRoutable('g-1', req());
    expect(invalidate).not.toHaveBeenCalled();
    expect(auth.setGroupRoutable).toHaveBeenCalledTimes(1);
  });

  it('a refusal from auth maps to its own HTTP answer, not to a generic failure', async () => {
    const { c } = make({ status: 'GROUP_STATUS_FORBIDDEN' });
    await expect(c.markRoutable('g-1', req())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GroupsController — proxying and status mapping', () => {
  it('takes caller identity from the claims, never from the body', async () => {
    const { c, auth } = make();
    await c.create({ name: 'Payments' }, req());
    expect(auth.createGroup).toHaveBeenCalledWith({
      callerAccountId: 'acct-1',
      callerUserId: 'admin-1',
      callerRoles: ['admin'],
      name: 'Payments',
    });
  });

  it('fails closed when there are no claims at all', async () => {
    const { c } = make();
    await expect(c.list({} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['GROUP_STATUS_NAME_TAKEN', ConflictException],
    ['GROUP_STATUS_INVALID_NAME', BadRequestException],
    ['GROUP_STATUS_UNKNOWN_PERMISSION', BadRequestException],
    ['GROUP_STATUS_ESCALATION', ForbiddenException],
    ['GROUP_STATUS_NOT_FOUND', NotFoundException],
    ['GROUP_STATUS_FORBIDDEN', ForbiddenException],
  ])('maps %s to its own HTTP answer', async (status, expected) => {
    const { c } = make({ status });
    await expect(c.create({ name: 'x' }, req())).rejects.toBeInstanceOf(expected);
  });

  it('never echoes the caller’s permission key back in an error', async () => {
    // Feature 021's second lesson: an unknown key is arbitrary caller input, and reflecting it puts
    // unvalidated text through the gateway and into its logs.
    const { c } = make({ status: 'GROUP_STATUS_UNKNOWN_PERMISSION' });
    await expect(c.grant('g-1', 'evil<script>', req())).rejects.toThrow(/unknown permission key/);
    await expect(c.grant('g-1', 'evil<script>', req())).rejects.not.toThrow(/evil/);
  });
});
