import { Inject, Injectable } from '@nestjs/common';
import type { RecoveryReason } from '@crm/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { CLOCK, type Clock } from './ports/clock';
import { TokenService } from './token.service';
import { RefreshService } from './refresh.service';
import { policyFromConfig, validatePassword, type PasswordFailure } from './password-policy';

/**
 * ⭐ W36 / feature 041 (roadmap 3.18) — **THE ONE PLACE A PASSWORD IS SET.**
 *
 * ── Why this exists as its own service ───────────────────────────────────────────────────────────
 * Two surfaces need it: recovery (somebody who cannot sign in, holding a mailbox proof) and the
 * signed-in change (somebody who knows the current one). They share nothing else — different
 * authentication, different refusals, different screens — and everything about setting a password:
 * the policy, the hash, the ONE credential row, `last_rotated_at`, killing every session, the entry in
 * the trail.
 *
 * **The real risk this feature carries is two places setting a password differently**, and it is not
 * hypothetical: feature 011 shipped two audit stores because the second surface that needed one found
 * writing a fresh table easier than routing through the existing writer. A shared write is what makes
 * "recovery and change agree" a property of the code rather than of two reviewers' memories, and
 * `password-single-writer.spec.ts` fails the build if a second place ever writes `secret_hash`.
 *
 * ⚠️ **What "every session dies" means, exactly** (FR-008). `revokeUserChain` kills the refresh chain,
 * so nothing can renew itself — but an ACCESS token already in a browser keeps working until it
 * expires (~15 minutes), except on routes that check a permission. That bound is stated here, in the
 * contract and in the UI copy, and it is reported as a NUMBER (`revokedCount`) rather than as a
 * promise: "signed out everywhere" without a number is how the bound gets forgotten.
 *
 * ⚠️ **There is no `userId` a CALLER chooses.** Both entry points resolve the subject themselves — the
 * token's owner, or the authenticated caller. This service takes one because it is internal; nothing
 * above it offers an administrator a way to set somebody else's password, and that absence is the
 * control (the same shape W31 used for least privilege).
 */

export type SetPasswordOutcome =
  | { status: 'ok'; revokedCount: number }
  | { status: 'weak'; failures: PasswordFailure[] }
  | { status: 'no_credential' };

export interface SetPasswordInput {
  accountId: string;
  userId: string;
  newPassword: string;
  /**
   * Which act this is, for the trail. `recovery.completed` when a link was used; `password.changed`
   * when somebody signed in changed their own. ⚠️ Not derived from anything here: the same write
   * serves two acts and guessing which one from context is how a trail starts lying.
   */
  action: 'recovery.completed' | 'password.changed';
  /** The person themselves for a signed-in change; a system ref for the recovery path. */
  actor: { userId: string } | { systemRef: string };
}

@Injectable()
export class PasswordService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RefreshService) private readonly refresh: RefreshService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /** Does this password match the one stored now? Used by the CHANGE path, which knows the old one. */
  async matchesCurrent(userId: string, candidate: string): Promise<boolean> {
    const credential = await this.prisma.credential.findFirst({
      where: { user_id: userId, type: 'password' },
    });
    if (!credential?.secret_hash) return false;
    return this.tokens.verifyPassword(credential.secret_hash, candidate);
  }

  /**
   * Set it. Policy first, then the write and the revocation and the entry in ONE transaction.
   *
   * ⚠️ The order is deliberate: a refused policy must leave nothing behind, so validation happens
   * before anything opens. And the audit statement is built before the transaction too (the
   * repository's own rule — an inexpressible detail means the act never starts rather than being
   * rolled back).
   */
  async setPassword(input: SetPasswordInput): Promise<SetPasswordOutcome> {
    const policy = policyFromConfig(this.cfg);
    const verdict = validatePassword(input.newPassword, policy);
    if (!verdict.ok) return { status: 'weak', failures: verdict.failures };

    // ⚠️ The ONE credential row — `@@unique([user_id, type])`, added by W1 after a live run found two
    // and `findFirst` became a coin toss between hashes. There is deliberately no create-if-missing
    // here: a person with no credential row has never registered, and inventing one would let a
    // recovery link complete a registration it was not part of.
    const credential = await this.prisma.credential.findFirst({
      where: { user_id: input.userId, type: 'password' },
    });
    if (!credential) return { status: 'no_credential' };

    const hash = await this.tokens.hashPassword(input.newPassword);
    const now = this.clock.now();

    // Killing the sessions is NOT inside the transaction, and that is a decision rather than an
    // oversight: `revokeUserChain` is an `updateMany` over another table, and if the two were one
    // transaction a lock contention there could roll back a password the person has already been told
    // was set. The order chosen is the safe one — the hash lands first, so the worst case is a
    // password that changed with sessions still renewable for up to their lifetime, which the next
    // sign-in fixes. The reverse order would sign somebody out and leave the old password working.
    const revokedCount = await this.prisma.$transaction(async (tx) => {
      await (tx as unknown as {
        credential: { update(a: Record<string, unknown>): Promise<unknown> };
      }).credential.update({
        where: { id: credential.id },
        // ⭐ `last_rotated_at` has existed since Phase 3 with NO WRITER. This is the first thing that
        // sets it, which is what makes "when did this password last change" answerable at all.
        data: { secret_hash: hash, last_rotated_at: now },
      });
      return this.refresh.revokeUserChain(input.userId);
    });

    await this.audit.append(input.accountId, {
      action: input.action,
      // ⚠️ `actorUserId` is always present in the type and EMPTY for a system actor — `buildEntry`
      // refuses an empty one only when the kind is `user`, and refuses a system actor with no
      // `actorRef`. Both halves are the catalogue's rule, not this file's.
      ...('userId' in input.actor
        ? { actorUserId: input.actor.userId }
        : { actorUserId: '', actorKind: 'system' as const, actorRef: input.actor.systemRef }),
      targetRef: input.userId,
      // `ok` and the count. ⛔ Never the password, never which policy rule failed (that refusal never
      // reaches here), never the address.
      detail: { reasonClass: 'ok' satisfies RecoveryReason, revokedCount },
    });

    return { status: 'ok', revokedCount };
  }
}
