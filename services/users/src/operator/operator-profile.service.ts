import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Create-if-absent for the caller's OWN operator profile (roadmap 5.10, MVP block W1).
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────────
 * Registration writes `User` + `Credential` + `UserRole` into `auth_db` and stops. Being *assignable*
 * needs an `Operator` row in `users_db`, and **nothing in the product ever wrote one** — only the seed
 * and test fixtures. So `AssignPlayer` answered `no such manager` for a manager who plainly existed,
 * every seeded user worked and every invited human being did not, and each half of the product was
 * individually correct.
 *
 * ⚠️ **The subject is the CALLER, never an argument.** `EnsureOwnOperatorRequest` has no
 * `auth_user_id` field, so this can mint a profile for exactly one person: whoever is calling. That
 * is what makes it safe to reach from the registration tail, which is `@Public` by necessity — the
 * worst a leaked call can do is create the caller's own row, and a profile grants nothing by itself
 * (every access decision remains auth's roles + permissions). Roadmap 5.11 needs this same shape, so
 * it inherits this surface instead of inventing a second one.
 *
 * ⚠️ **An existing profile is returned UNCHANGED — the display name is not refreshed.** A name is
 * editable elsewhere (roadmap 8.10); a login that overwrote it would silently undo a person's own
 * edit every time they signed in. "Ensure" means *exists*, not *matches what the caller believes*.
 *
 * ⚠️ **`active` is not touched either.** Reactivating a deactivated account is an explicit admin act
 * (roadmap 3.16). If a login re-activated the profile, deactivation would be undone by the leaver
 * simply signing in — the offboarding hole 3.16 exists to close.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface OperatorProfile {
  operatorId: string;
  accountId: string;
  displayName: string | null;
  active: boolean;
  /** True when THIS call created the row. Reported for the audit-free diagnostics the live run reads. */
  created: boolean;
}

@Injectable()
export class OperatorProfileService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Idempotent. Racing calls (the registration tail and a first login can genuinely overlap) are
   * resolved by the `(account_id, auth_user_id)` UNIQUE index rather than by ordering: the loser of
   * the race gets a constraint violation, re-reads and returns the winner's row.
   */
  async ensureOwn(
    accountId: string,
    authUserId: string,
    displayName: string | null,
  ): Promise<OperatorProfile> {
    if (!accountId || !authUserId) {
      // Fail closed. A blank subject would upsert a row keyed on an empty string — one shared,
      // ownerless profile that any caller with missing metadata would then be handed.
      throw new Error('operator profile requires an account and an identity');
    }

    const db = this.prisma.forAccount(accountId);

    const existing = (await db.operator.findFirst({
      where: { auth_user_id: authUserId },
      select: { id: true, account_id: true, display_name: true, active: true },
    })) as { id: string; account_id: string; display_name: string | null; active: boolean } | null;

    if (existing) {
      return {
        operatorId: existing.id,
        accountId: existing.account_id,
        displayName: existing.display_name,
        active: existing.active,
        created: false,
      };
    }

    try {
      const row = (await db.operator.create({
        data: {
          account_id: accountId,
          auth_user_id: authUserId,
          display_name: displayName,
        },
        select: { id: true, account_id: true, display_name: true, active: true },
      })) as { id: string; account_id: string; display_name: string | null; active: boolean };

      return {
        operatorId: row.id,
        accountId: row.account_id,
        displayName: row.display_name,
        active: row.active,
        created: true,
      };
    } catch (err) {
      // The race, resolved by the index. Anything else is re-thrown: swallowing a write error here
      // would report a profile that does not exist, which is the failure mode this whole point is
      // about.
      if (!isUniqueViolation(err)) throw err;

      const won = (await db.operator.findFirst({
        where: { auth_user_id: authUserId },
        select: { id: true, account_id: true, display_name: true, active: true },
      })) as { id: string; account_id: string; display_name: string | null; active: boolean } | null;

      if (!won) throw err; // a violation with nothing to find is not the race — surface it
      return {
        operatorId: won.id,
        accountId: won.account_id,
        displayName: won.display_name,
        active: won.active,
        created: false,
      };
    }
  }
}

/** Prisma's unique-constraint code. Checked by CODE, not by message text, which is localized. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}
