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
 * ⭐ The ONLY role the staff-provisioning API can produce (ADR 0043 §2, SEC-PV1). Provisional — its
 * permissions are one line in `rbac/catalogue.ts` and Q26 owns the final set — but its IDENTITY as
 * «the weakest role a machine may mint» is not provisional at all.
 */
const PROVISIONING_ROLE = 'newcomer';

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

  /**
   * ⭐ W31 / 038 (roadmap 3.15, ADR 0043 §2) — the MACHINE's entrance to this same pipeline.
   *
   * ── Why a second method rather than a parameter ─────────────────────────────────────────────────
   * `createInvitation` above authorises by comparing the INVITER's roles (`canInvite`). A machine
   * holding a shared secret has no roles, so that protection does not transfer — it would either
   * refuse everything or, worse, be «fixed» by passing a role in.
   *
   * ⚠️ **This method takes NO role argument, and that absence IS the least-privilege bar** (SEC-PV1,
   * which demands it be structural rather than «a check that could be reordered away»). The role is
   * the constant below. There is no field to smuggle `admin` through, no default to override and no
   * ordering to get wrong: the only account this path can mint is the weakest one in the catalogue.
   *
   * Everything else is deliberately the SAME as the human path — one token shape, one hash, one
   * outbox transaction, one registration flow — because ADR 0033's property is that a credential
   * comes into being in exactly one way, and this feature must extend that rather than dent it.
   */
  async createProvisioningInvitation(
    accountId: string,
    email: string,
    machineActorRef: string,
  ): Promise<InviteOutcome> {
    const targetRole = await this.prisma.role.findUnique({
      where: { account_id_key: { account_id: accountId, key: PROVISIONING_ROLE } },
    });
    // A stand that has not been re-seeded since this feature has no such role. Refusing is the only
    // honest answer: inventing the row here would create a role nobody granted anything to, and
    // falling back to an existing role would hand the machine a stronger one than it may have.
    if (!targetRole) return { status: 'forbidden' };

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await this.tokens.hashPassword(secret);
    const expiresAt = new Date(this.clock.now().getTime() + this.cfg.INVITE_TTL * 1000);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          account_id: accountId,
          email,
          role_key: PROVISIONING_ROLE,
          // The trail says a machine did this, and which one. `invited_by` is a user id everywhere
          // else, so the provisioning marker is prefixed and never collides with one.
          invited_by: machineActorRef,
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
          accountId,
        },
        tx,
      );
      return created;
    });

    await this.ensureInvitedUser(email, accountId, targetRole.id);
    // ⭐ The RE-HIRE half. See the method's own header for why `ensureInvitedUser` alone is not enough.
    await this.reinstateDisabledUser(email, accountId, targetRole.id);
    return { status: 'created', invitationId: row.id };
  }

  /**
   * ⭐ W31 / 038 (ADR 0043 §7) — put a DEACTIVATED colleague back into an invitable state.
   *
   * ── The defect this exists because of, because it is worth not repeating ────────────────────────
   * `ensureInvitedUser` returns early when the email already exists — correctly, since its job is to
   * avoid duplicating or escalating an account. But the re-hire path runs against somebody who DOES
   * exist and is `disabled`, so the invitation was written, the mail was sent, the API answered
   * `202 reactivated`… and the person could not come back: `register/start` refuses a user who is not
   * invitable, and their roles had been dropped by the offboarding. A success that was not one — the
   * exact shape this whole block keeps finding. The research flagged the hazard in advance
   * («the re-hire path must not inherit that behaviour») and the first implementation inherited it
   * anyway; the live round is what caught it.
   *
   * ── ⚠️ It touches a DISABLED user and nothing else ──────────────────────────────────────────────
   * The predicate is in the WHERE clause, not in an `if` above it: an active account cannot be
   * reset to `invited` by this path however it is called, so the machine can never knock a working
   * colleague out of their session. Roles are only ADDED, never replaced — and only the newcomer
   * role, which is the sole role this file can name (SEC-PV1). Whatever they held before is gone
   * because the offboarding dropped it; restoring more than the starter role is Access Management's
   * decision and a human's, not a webhook's.
   */
  private async reinstateDisabledUser(email: string, accountId: string, roleId: string): Promise<void> {
    const { count } = await this.prisma.user.updateMany({
      where: { account_id: accountId, email, status: 'disabled' },
      data: { status: 'invited' },
    });
    if (count === 0) return; // nobody was disabled — an ordinary invitation, already handled above.
    const user = await this.prisma.user.findFirst({ where: { account_id: accountId, email } });
    if (!user) return;
    // Idempotent: a second reactivation before the first is completed must not throw on the binding.
    await this.prisma.userRole.createMany({
      data: [{ user_id: user.id, role_id: roleId }],
      skipDuplicates: true,
    });
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
