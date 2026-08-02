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
 * may invite non-super, non-admin roles; nobody may invite a super-admin. This checks the HIERARCHY
 * only; the target role must ALSO exist in the account's catalogue (feature 011) — validated in
 * `createInvitation`, so an unknown/empty `role_key` is rejected rather than silently created.
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
    // The target role MUST exist in this account's catalogue (feature 011 seeds the 7 roles). An
    // unknown/empty role_key is rejected here — never silently upserted into a blank-key Role.
    const targetRole = await this.prisma.role.findUnique({
      where: { account_id_key: { account_id: inviter.accountId, key: roleKey } },
    });
    if (!targetRole) return { status: 'forbidden' };
    if (
      !this.rate.allow(`invite:${inviter.userId}`, this.cfg.INVITE_RATE_MAX, this.cfg.INVITE_RATE_WINDOW)
    ) {
      return { status: 'rate_limited' };
    }

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await this.tokens.hashPassword(secret);
    const expiresAt = new Date(this.clock.now().getTime() + this.cfg.INVITE_TTL * 1000);
    // ⭐ Feature 028 — the invitation and the message that carries it are one transaction. An
    // invitation nobody is ever sent is not an invitation; it is a row that makes an administrator
    // believe they invited somebody.
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          account_id: inviter.accountId,
          email,
          role_key: roleKey,
          invited_by: inviter.userId,
          token_hash: tokenHash,
          expires_at: expiresAt,
        },
      });

      await this.email.sendInvite(
        {
          to: email,
          inviteToken: `${created.id}.${secret}`,
          invitationId: created.id,
          expiresAt,
          accountId: inviter.accountId,
        },
        tx,
      );

      return created;
    });

    // Outside the transaction on purpose: pre-creating the invited user is a separate concern with
    // its own "unless one already exists" rule, and rolling the invitation back because of it
    // would be the wrong trade.
    await this.ensureInvitedUser(email, inviter.accountId, targetRole.id);

    return { status: 'created', invitationId: row.id };
  }

  /** Pre-create the invited User (non-active) + bind the (already-validated) role, unless an account
   * already exists for the email. `roleId` is a catalogue role validated in `createInvitation`. */
  private async ensureInvitedUser(email: string, accountId: string, roleId: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) return; // do not duplicate or escalate an existing account.
    const user = await this.prisma.user.create({
      data: { account_id: accountId, email, status: 'invited' },
    });
    await this.prisma.userRole.create({ data: { user_id: user.id, role_id: roleId } });
  }
}
