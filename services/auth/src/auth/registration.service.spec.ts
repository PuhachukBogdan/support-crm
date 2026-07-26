import { JwtService } from '@nestjs/jwt';
import { RegistrationService } from './registration.service';
import { InviteService, type Inviter } from './invite.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { OutboxEmailAdapter } from './ports/email.port';
import type { Clock } from './ports/clock';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T024 (feature 010, US3) — registration via invite. FAILS before RegistrationService exists.
 * Sets up a real invite (InviteService) then drives start/complete over shared fakes.
 */
describe('RegistrationService', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z');
  const clock: Clock = { now: () => NOW };
  const cfg = makeAuthConfig();
  const superAdmin: Inviter = { userId: 'sa-1', accountId: 'acct-1', roles: ['super_admin'] };

  async function setup(prisma: FakePrisma, email = 'invitee@example.test', role = 'manager') {
    const outbox = new OutboxEmailAdapter();
    const tokens = new TokenService(cfg, clock, prisma as never, new JwtService({}));
    const otp = new OtpService(cfg, clock, prisma as never, outbox);
    const invites = new InviteService(cfg, clock, prisma as never, tokens, new RateLimiter(clock), outbox);
    const registration = new RegistrationService(cfg, clock, prisma as never, otp, tokens);
    await invites.createInvitation(superAdmin, email, role);
    const token = outbox.inviteOutbox[0]!.inviteToken;
    return { registration, outbox, tokens, token, prisma };
  }

  it('valid invite → start emits code → complete activates the user with the invited role + session', async () => {
    const prisma = makeFakePrisma();
    const { registration, outbox, token } = await setup(prisma);

    const start = await registration.startRegistration(token, 'invitee@example.test');
    expect(start.status).toBe('code_sent');
    const code = outbox.last()!.code;

    const done = await registration.completeRegistration(token, 'invitee@example.test', code, 'Passw0rd!');
    expect(done.status).toBe('ok');
    if (done.status !== 'ok') throw new Error('unreachable');
    expect(done.pair.accessToken).toBeTruthy();

    const user = prisma._tables.users.find((u) => u.email === 'invitee@example.test')!;
    expect(user.status).toBe('active');
    expect(prisma._tables.userRoles).toContainEqual({ user_id: user.id, roleKey: 'manager' });
    expect(prisma._tables.invitations[0]!.consumed_at).not.toBeNull(); // single-use
    expect(prisma._tables.credentials.find((c) => c.user_id === user.id)?.secret_hash).toBeTruthy();
  });

  it('email mismatch → refused', async () => {
    const prisma = makeFakePrisma();
    const { registration, token } = await setup(prisma);
    expect((await registration.startRegistration(token, 'someone-else@example.test')).status).toBe('invalid');
    const done = await registration.completeRegistration(token, 'someone-else@example.test', '123456', 'Passw0rd!');
    expect(done.status).toBe('invalid');
  });

  it('wrong code → refused, nothing activated', async () => {
    const prisma = makeFakePrisma();
    const { registration, token } = await setup(prisma);
    await registration.startRegistration(token, 'invitee@example.test');
    const done = await registration.completeRegistration(token, 'invitee@example.test', 'WRONG9', 'Passw0rd!');
    expect(done.status).toBe('invalid');
    expect(prisma._tables.users.find((u) => u.email === 'invitee@example.test')!.status).toBe('invited');
  });

  it('weak password → rejected, nothing activated', async () => {
    const prisma = makeFakePrisma();
    const { registration, outbox, token } = await setup(prisma);
    await registration.startRegistration(token, 'invitee@example.test');
    const code = outbox.last()!.code;
    const done = await registration.completeRegistration(token, 'invitee@example.test', code, 'weak');
    expect(done.status).toBe('weak_password');
    expect(prisma._tables.users.find((u) => u.email === 'invitee@example.test')!.status).toBe('invited');
  });

  it('a consumed invite cannot be reused', async () => {
    const prisma = makeFakePrisma();
    const { registration, outbox, token } = await setup(prisma);
    await registration.startRegistration(token, 'invitee@example.test');
    const code = outbox.last()!.code;
    expect((await registration.completeRegistration(token, 'invitee@example.test', code, 'Passw0rd!')).status).toBe('ok');
    // Second attempt with the same (now consumed) invite:
    expect((await registration.startRegistration(token, 'invitee@example.test')).status).toBe('invalid');
  });

  it('an expired invite is refused', async () => {
    const prisma = makeFakePrisma();
    const { registration, token, prisma: p } = await setup(prisma);
    // Force expiry into the past.
    p._tables.invitations[0]!.expires_at = new Date(NOW.getTime() - 1000);
    expect((await registration.startRegistration(token, 'invitee@example.test')).status).toBe('invalid');
  });

  it('a garbage token is refused', async () => {
    const prisma = makeFakePrisma();
    const { registration } = await setup(prisma);
    expect((await registration.startRegistration('not-a-real-token', 'invitee@example.test')).status).toBe('invalid');
  });
});
