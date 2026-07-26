import { InviteService, canInvite, type Inviter } from './invite.service';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { OutboxEmailAdapter } from './ports/email.port';
import { JwtService } from '@nestjs/jwt';
import type { Clock } from './ports/clock';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T018 (feature 010, US2) — admin-center invites. FAILS before InviteService exists.
 */
describe('canInvite (hierarchy — FR-008)', () => {
  it('super-admin may invite admin and non-super roles', () => {
    expect(canInvite(['super_admin'], 'admin')).toBe(true);
    expect(canInvite(['super_admin'], 'manager')).toBe(true);
  });
  it('admin may invite non-super, non-admin roles but NOT admins', () => {
    expect(canInvite(['admin'], 'manager')).toBe(true);
    expect(canInvite(['admin'], 'admin')).toBe(false);
  });
  it('nobody may invite a super-admin', () => {
    expect(canInvite(['super_admin'], 'super_admin')).toBe(false);
    expect(canInvite(['admin'], 'super_admin')).toBe(false);
  });
  it('a non-privileged caller may invite nobody', () => {
    expect(canInvite(['manager'], 'manager')).toBe(false);
    expect(canInvite([], 'manager')).toBe(false);
  });
});

describe('InviteService', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z');
  const clock: Clock = { now: () => NOW };

  function build(prisma: FakePrisma, cfg = makeAuthConfig()) {
    const email = new OutboxEmailAdapter();
    const tokens = new TokenService(cfg, clock, prisma as never, new JwtService({}));
    const rate = new RateLimiter(clock);
    const service = new InviteService(cfg, clock, prisma as never, tokens, rate, email);
    return { service, email, prisma, cfg };
  }

  const superAdmin: Inviter = { userId: 'sa-1', accountId: 'acct-1', roles: ['super_admin'] };

  it('super-admin invites an admin → created, single-use token emailed, only hash at rest', async () => {
    const prisma = makeFakePrisma({ roles: [{ key: 'admin' }] });
    const { service, email } = build(prisma);

    const outcome = await service.createInvitation(superAdmin, 'newadmin@example.test', 'admin');
    expect(outcome.status).toBe('created');

    const row = prisma._tables.invitations[0]!;
    expect(row.email).toBe('newadmin@example.test');
    expect(row.role_key).toBe('admin');
    expect(row.expires_at.getTime()).toBe(NOW.getTime() + 86_400 * 1000);
    expect(row.consumed_at).toBeNull();

    // The emailed token is "<id>.<secret>"; only its hash is stored.
    expect(email.inviteOutbox).toHaveLength(1);
    const token = email.inviteOutbox[0]!.inviteToken;
    expect(token.startsWith(`${row.id}.`)).toBe(true);
    expect(row.token_hash).not.toContain(token.split('.')[1]);
    expect(row.token_hash.startsWith('$argon2')).toBe(true);

    // The invited user is pre-created non-active with the assigned role.
    const user = prisma._tables.users.find((u) => u.email === 'newadmin@example.test')!;
    expect(user.status).toBe('invited');
    expect(prisma._tables.userRoles).toContainEqual({ user_id: user.id, roleKey: 'admin' });
  });

  it('admin inviting an admin → forbidden (hierarchy)', async () => {
    const prisma = makeFakePrisma();
    const { service, email } = build(prisma);
    const outcome = await service.createInvitation(
      { userId: 'a-1', accountId: 'acct-1', roles: ['admin'] },
      'x@example.test',
      'admin',
    );
    expect(outcome.status).toBe('forbidden');
    expect(email.inviteOutbox).toHaveLength(0);
    expect(prisma._tables.invitations).toHaveLength(0);
  });

  it('inviting a super_admin → forbidden (never issuable)', async () => {
    const prisma = makeFakePrisma();
    const { service } = build(prisma);
    const outcome = await service.createInvitation(superAdmin, 'x@example.test', 'super_admin');
    expect(outcome.status).toBe('forbidden');
  });

  it('unknown/empty role → forbidden; no blank-key Role or invited user created (Track-B finding)', async () => {
    const prisma = makeFakePrisma({ roles: [{ key: 'admin' }] }); // catalogue has 'admin', not 'ghost'
    const { service, email } = build(prisma);
    const outcome = await service.createInvitation(superAdmin, 'ghost@example.test', 'ghost');
    expect(outcome.status).toBe('forbidden');
    expect(email.inviteOutbox).toHaveLength(0);
    expect(prisma._tables.invitations).toHaveLength(0);
    // the pre-011 bug created a blank/unknown Role + user here — must not happen now
    expect(prisma._tables.roles.find((r) => r.key === 'ghost')).toBeUndefined();
    expect(prisma._tables.users.find((u) => u.email === 'ghost@example.test')).toBeUndefined();
  });

  it('rate-limited after the configured max in the window', async () => {
    const prisma = makeFakePrisma({ roles: [{ key: 'manager' }] });
    const { service } = build(prisma, makeAuthConfig({ INVITE_RATE_MAX: 2, INVITE_RATE_WINDOW: 3600 }));
    expect((await service.createInvitation(superAdmin, 'a@example.test', 'manager')).status).toBe('created');
    expect((await service.createInvitation(superAdmin, 'b@example.test', 'manager')).status).toBe('created');
    expect((await service.createInvitation(superAdmin, 'c@example.test', 'manager')).status).toBe('rate_limited');
  });

  it('does not duplicate or escalate an existing account', async () => {
    const prisma = makeFakePrisma({
      users: [{ id: 'u9', email: 'exists@example.test', account_id: 'acct-1', status: 'active' }],
      roles: [{ key: 'manager' }],
    });
    const { service } = build(prisma);
    const before = prisma._tables.users.length;
    const outcome = await service.createInvitation(superAdmin, 'exists@example.test', 'manager');
    expect(outcome.status).toBe('created'); // invite still issued
    expect(prisma._tables.users).toHaveLength(before); // but no new/duplicated user
    expect(prisma._tables.users.find((u) => u.id === 'u9')!.status).toBe('active'); // unchanged
  });
});
