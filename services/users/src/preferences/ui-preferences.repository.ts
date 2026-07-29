import { Inject, Injectable } from '@nestjs/common';
import { resolveUiPreferences } from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * Operator UI-preference persistence (feature 021, roadmap 5.6 — US1).
 *
 * ⚠️ THE OPERATOR's appearance settings, never `Player.preferences_json` (the customer's VIP
 * portfolio data, tier `am_only`). See `libs/common/src/preferences/ui-preferences.ts`.
 *
 * `forAccount` on every access, without exception. That is what makes "not yours" and "does not
 * exist" the SAME query result rather than two branches a future edit could separate: there is no
 * `if (row.account_id !== caller)` here to get wrong, because a row from another account never comes
 * back at all.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

interface PreferenceRow {
  key: string;
  value: string;
}

@Injectable()
export class UiPreferencesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The complete set for one person: stored values merged over the catalogue defaults.
   *
   * ⚠️ **A read creates nothing.** Absence is not a state to be materialised — it is answered from
   * the catalogue. Materialising a row on first read would mean every page render writes, and it
   * would make "has this person ever chosen anything" unanswerable.
   */
  async read(accountId: string, authUserId: string): Promise<Record<string, string>> {
    const rows = (await this.prisma
      .forAccount(accountId)
      .operatorUiPreference.findMany({
        where: { auth_user_id: authUserId },
        select: { key: true, value: true },
      })) as PreferenceRow[];

    // Merging happens in the catalogue module, not here: a stale key or a retired value must be
    // ignored identically wherever rows are read, and one implementation is how that stays true.
    return resolveUiPreferences(rows);
  }

  /**
   * Apply a validated patch and return the resulting complete set.
   *
   * ⚠️ **Upsert per named key, never a whole-record replace.** Two browser tabs changing different
   * settings must not undo each other, and per-key writes make that safe with no locking and no
   * read-modify-write. Keys the patch does not name are not touched at all — not re-written, not
   * reset to their defaults.
   *
   * The entries are already validated against the closed catalogue by the caller; nothing here
   * re-decides what a valid key is, because two places deciding that is how they drift apart.
   */
  async apply(
    accountId: string,
    authUserId: string,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<Record<string, string>> {
    const db = this.prisma.forAccount(accountId);

    // A transaction so a multi-key patch is one visible change. FR-005 is enforced before this point
    // by validating the whole patch first; this closes the narrower window where a second write fails
    // and leaves a caller's screen half-applied.
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        db.operatorUiPreference.upsert({
          where: {
            account_id_auth_user_id_key: {
              account_id: accountId,
              auth_user_id: authUserId,
              key,
            },
          },
          create: { account_id: accountId, auth_user_id: authUserId, key, value },
          update: { value },
        }),
      ),
    );

    return this.read(accountId, authUserId);
  }
}
