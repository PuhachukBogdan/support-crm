import { Inject, Injectable } from '@nestjs/common';
import type { PresenceCause, PresenceState } from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * Presence persistence (feature 025, roadmap 5.9 — US1).
 *
 * ⚠️ Presence is **not** `Operator.active`. `active` means *the staff account is not deactivated*
 * (roadmap 3.16); presence means *this person is at their desk right now*. Both are read by
 * `OperatorRepository.resolveByAuthUsers`, which is the exact query where the two meet — conflating
 * them would make a person at lunch indistinguishable from a person who left the company.
 *
 * `forAccount` on every access, without exception. That is what makes "not yours" and "does not
 * exist" the SAME query result rather than two branches a future edit could separate: there is no
 * `if (row.account_id !== caller)` here to get wrong, because a row from another account never comes
 * back at all.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface PresenceRow {
  auth_user_id: string;
  state: string;
  last_cause: string | null;
  last_seen_at: Date | null;
  label_id: string | null;
}

/** What a person's presence is when no row exists. See `read` for why this is not materialised. */
export const DEFAULT_PRESENCE: Omit<PresenceRow, 'auth_user_id'> = {
  state: 'offline',
  last_cause: null,
  last_seen_at: null,
  label_id: null,
};

@Injectable()
export class PresenceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * One person's presence.
   *
   * ⚠️ **A read creates nothing.** Absence is not a state to be materialised — it is answered as
   * `offline`, because presence is a statement about a live session and absent a session `offline`
   * is the only honest answer (FR-011). Materialising on first read would mean every desk view
   * writes a row per operator, and it would make "has this person ever started a shift?"
   * unanswerable. The same rule feature 021 applies to UI preferences.
   */
  async read(accountId: string, authUserId: string): Promise<PresenceRow> {
    const row = (await this.prisma.forAccount(accountId).operatorPresence.findFirst({
      where: { auth_user_id: authUserId },
    })) as PresenceRow | null;
    return row ?? { auth_user_id: authUserId, ...DEFAULT_PRESENCE };
  }

  /** Many at once — one query, never one per person (Principle VII). */
  async readMany(accountId: string, authUserIds: readonly string[]): Promise<Map<string, PresenceRow>> {
    if (authUserIds.length === 0) return new Map();
    const rows = (await this.prisma.forAccount(accountId).operatorPresence.findMany({
      where: { auth_user_id: { in: [...authUserIds] } },
    })) as PresenceRow[];
    return new Map(rows.map((r) => [r.auth_user_id, r]));
  }

  /**
   * The channels a person has switched OFF.
   *
   * There is no "switched on" to read: a row's existence IS the block, so an empty result means
   * available everywhere. Read for the whole candidate set in ONE query — an N+1 here would sit on
   * the auto-assignment path.
   */
  async blockedChannels(
    accountId: string,
    authUserIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (authUserIds.length === 0) return new Map();
    const rows = (await this.prisma.forAccount(accountId).operatorChannelBlock.findMany({
      where: { auth_user_id: { in: [...authUserIds] } },
      select: { auth_user_id: true, channel: true },
    })) as Array<{ auth_user_id: string; channel: string }>;

    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.auth_user_id);
      if (list) list.push(r.channel);
      else out.set(r.auth_user_id, [r.channel]);
    }
    return out;
  }

  /** Does this person have an operator profile in this account, and is it active? */
  async operatorFor(
    accountId: string,
    authUserId: string,
  ): Promise<{ operatorId: string; active: boolean } | null> {
    const row = (await this.prisma.forAccount(accountId).operator.findFirst({
      where: { auth_user_id: authUserId },
      select: { id: true, active: true },
    })) as { id: string; active: boolean } | null;
    return row ? { operatorId: row.id, active: row.active } : null;
  }

  /**
   * Everyone whose last activity is older than `cutoff` and who is not already at `atOrBelow`.
   *
   * The sweep's only query, and the reason `@@index([account_id, last_seen_at])` exists. Batched
   * with a caller-clamped limit: a tick that tried to lower an entire tenant at once would hold one
   * transaction open across every row in the table.
   *
   * ⚠️ Cross-account **by design**, and therefore the ONE method here that does not go through
   * `forAccount`. The caller is a scheduler, not a session; the rpc that reaches it is
   * system-actor-only with no gateway route, exactly like the artefact purge that established this
   * shape (feature 017). A sweep confined to one account would need the scheduler to enumerate
   * tenants, which is a list the worker has no business holding.
   */
  async idleSince(cutoff: Date, limit: number): Promise<Array<PresenceRow & { account_id: string }>> {
    return (await this.prisma.operatorPresence.findMany({
      where: {
        state: { not: 'offline' },
        // ⚠️ `lt` ALONE. A row that has never been active cannot go idle — it is already `offline` by
        // default — and `lt` already excludes NULL in SQL, so the `not: null` the first draft added
        // "for clarity" was redundant AND rejected by Prisma at runtime. Found in the users log on
        // the first live run: the sweep threw on every tick and still reported counts, so nothing
        // upstream noticed.
        last_seen_at: { lt: cutoff },
      },
      orderBy: { last_seen_at: 'asc' },
      take: limit,
    })) as Array<PresenceRow & { account_id: string }>;
  }

  /**
   * Write the new state and record the transition **in one transaction**.
   *
   * The two are inseparable: a rolled-back change must leave no record, and a record must always
   * correspond to something that really happened (FR-006). The caller decides *whether* to write —
   * a no-op never reaches here, so this method has no "did anything change?" branch to get wrong.
   */
  async applyState(
    accountId: string,
    authUserId: string,
    next: { state: PresenceState; cause: PresenceCause; labelId?: string | null },
    recordTransition: (tx: unknown) => unknown,
    /**
     * The audit entry, for the ONE presence act that is also a sensitive action: a supervisor setting
     * somebody else's presence (FR-023). Absent for every other path, and that absence is the
     * decision — a statement about oneself is history, not a sensitive action, and ~58 agents
     * toggling several times a day would bury the entries that matter.
     *
     * It rides the SAME transaction as the state change and the transition. Feature 015's rule: if
     * the entry cannot be written, the action is refused rather than performed unrecorded.
     */
    recordAudit?: (tx: unknown) => unknown,
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        operatorPresence: {
          upsert(args: Record<string, unknown>): Promise<unknown>;
        };
      };
      await client.operatorPresence.upsert({
        where: { account_id_auth_user_id: { account_id: accountId, auth_user_id: authUserId } },
        create: {
          account_id: accountId,
          auth_user_id: authUserId,
          state: next.state,
          last_cause: next.cause,
          label_id: next.labelId ?? null,
        },
        update: {
          state: next.state,
          last_cause: next.cause,
          ...(next.labelId === undefined ? {} : { label_id: next.labelId }),
        },
      });
      await recordTransition(tx);
      if (recordAudit) await recordAudit(tx);
    });
  }

  /**
   * Stamp activity WITHOUT changing the state.
   *
   * Deliberately separate from `applyState`: an activity timestamp is not a transition, so this
   * writes no history and must not be able to. Making it one method with a flag is how "exactly one
   * record per change" becomes "one record per heartbeat" — 58 agents × once a minute.
   */
  async touch(accountId: string, authUserId: string, at: Date): Promise<void> {
    await this.prisma.forAccount(accountId).operatorPresence.upsert({
      where: { account_id_auth_user_id: { account_id: accountId, auth_user_id: authUserId } },
      create: {
        account_id: accountId,
        auth_user_id: authUserId,
        state: 'offline',
        last_cause: null,
        last_seen_at: at,
      },
      update: { last_seen_at: at },
    });
  }

  /** Switch a channel off (insert) or back on (delete). There is no stored `true`. */
  async setChannelBlock(
    accountId: string,
    authUserId: string,
    channel: string,
    blocked: boolean,
    recordTransition: (tx: unknown) => unknown,
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        operatorChannelBlock: {
          create(args: Record<string, unknown>): Promise<unknown>;
          deleteMany(args: Record<string, unknown>): Promise<unknown>;
        };
      };
      if (blocked) {
        await client.operatorChannelBlock.create({
          data: { account_id: accountId, auth_user_id: authUserId, channel },
        });
      } else {
        await client.operatorChannelBlock.deleteMany({
          where: { account_id: accountId, auth_user_id: authUserId, channel },
        });
      }
      await recordTransition(tx);
    });
  }
}
