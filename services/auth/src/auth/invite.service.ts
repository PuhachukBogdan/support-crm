import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { EMAIL_PORT, type EmailPort } from './ports/email.port';

/** Who is issuing the invite (from the gateway-validated access JWT — Principle II). */
export interface Inviter {
  userId: string;
  accountId: string;
  roles: string[];
}

export type InviteOutcome =
  | { status: 'created'; invitationId: string }
  | { status: 'forbidden' }
  | { status: 'rate_limited' };

/**
 * Whodunnit rule (FR-008 / research R8): super-admin may invite admins + any non-super role; admin
 * may invite non-super, non-admin roles; nobody may invite a super-admin. `role_key` is an opaque
 * string here — the concrete catalog is feature 011 (N1).
 */
export function canInvite(callerRoles: string[], roleKey: string): boolean {
  if (roleKey === 'super_admin') return false; // super-admins originate only from the whitelist.
  const isSuper = callerRoles.includes('super_admin');
  const isAdmin = callerRoles.includes('admin');
  if (!isSuper && !isAdmin) return false;
  if (roleKey === 'admin') return isSuper; // only a super-admin may invite an admin.
  return isSuper || isAdmin;
}

/**
 * InviteService (feature 010, roadmap 3.9). An admin/super-admin issues a single-use, expiring
 * invite bound to an email + role. The token secret leaves only in the emailed link; at rest we
 * keep its argon2id hash. Issuance enforces the hierarchy (server-side) and is rate-limited.
 * The target User is pre-created in `invited` status so the registration code can attach (R5);
 * 009 login already refuses non-active users, so it cannot sign in until registration completes.
 */
@Injectable()
export class InviteService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RateLimiter) private readonly rate: RateLimiter,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  async createInvitation(inviter: Inviter, email: string, roleKey: string): Promise<InviteOutcome> {
    if (!canInvite(inviter.roles, roleKey)) return { status: 'forbidden' };
    if (
      !this.rate.allow(`invite:${inviter.userId}`, this.cfg.INVITE_RATE_MAX, this.cfg.INVITE_RATE_WINDOW)
    ) {
      return { status: 'rate_limited' };
    }

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await this.tokens.hashPassword(secret);
    const expiresAt = new Date(this.clock.now().getTime() + this.cfg.INVITE_TTL * 1000);
    const row = await this.prisma.invitation.create({
      data: {
        account_id: inviter.accountId,
        email,
        role_key: roleKey,
        invited_by: inviter.userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    });

    await this.ensureInvitedUser(email, inviter.accountId, roleKey);

    await this.email.sendInvite({
      to: email,
      inviteToken: `${row.id}.${secret}`,
      invitationId: row.id,
      expiresAt,
    });
    return { status: 'created', invitationId: row.id };
  }

  /** Pre-create the invited User (non-active) + role, unless an account already exists for the email. */
  private async ensureInvitedUser(email: string, accountId: string, roleKey: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) return; // do not duplicate or escalate an existing account.
    const user = await this.prisma.user.create({
      data: { account_id: accountId, email, status: 'invited' },
    });
    const role = await this.prisma.role.upsert({
      where: { account_id_key: { account_id: accountId, key: roleKey } },
      create: { account_id: accountId, key: roleKey },
      update: {},
    });
    await this.prisma.userRole.create({ data: { user_id: user.id, role_id: role.id } });
  }
}
