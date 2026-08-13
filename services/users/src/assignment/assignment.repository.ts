import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Player ↔ account-manager attachment persistence (feature 026, roadmap 5.7).
 *
 * ⚠️ **A row here GRANTS ACCESS.** It hands the manager the player's portfolio, preferences and AM
 * notes. It is not a "mine" marker, and every method below is written as if it were a permission
 * change — because it is one.
 *
 * `forAccount` on every access, without exception. That is what makes "not yours" and "does not
 * exist" the SAME query result rather than two branches a future edit could separate.
 *
 * ⚠️ **The player is `(account, brand, player_id)`.** A bare platform id names two people: the same
 * value under two brands is routinely two different human beings (feature 020). There is no method
 * here that takes a `player_id` alone, deliberately — the missing overload is the guarantee.
 *
 * ⚠️ **There is no delete.** Detaching CLOSES a period (`ended_at`); the row stays. That is FR-003,
 * and `tests/data-model/assignment-history-is-additive.spec.ts` fails the build if a delete appears
 * anywhere in the product.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface AssignmentRow {
  id: string;
  brand_id: string;
  player_id: string;
  am_auth_user_id: string;
  assigned_by: string;
  started_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
}

/** The player's full identity. Never a bare `player_id` (feature 020). */
export interface PlayerRef {
  brandId: string;
  playerId: string;
}

@Injectable()
export class AssignmentRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Who looks after this player right now? `null` = nobody, which is a real and common state. */
  async activeFor(accountId: string, player: PlayerRef): Promise<AssignmentRow | null> {
    return (await this.prisma.forAccount(accountId).playerAssignment.findFirst({
      where: { brand_id: player.brandId, player_id: player.playerId, ended_at: null },
    })) as AssignmentRow | null;
  }

  /**
   * ⭐ Is this manager attached to this player? The question the NARROWING asks on every masked read.
   *
   * A dedicated method rather than a caller filtering `activeFor`, because it answers a yes/no and
   * must stay cheap: it sits on the hottest read surface in the product.
   */
  async isAttached(accountId: string, player: PlayerRef, amAuthUserId: string): Promise<boolean> {
    const row = await this.prisma.forAccount(accountId).playerAssignment.findFirst({
      where: {
        brand_id: player.brandId,
        player_id: player.playerId,
        am_auth_user_id: amAuthUserId,
        ended_at: null,
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The same question for a whole PAGE of players, in ONE query.
   *
   * ⚠️ Never one call per row. The list read already does exactly one membership lookup for the whole
   * page (feature 022's shape, with a test that counts queries rather than trusting a comment), and
   * an N+1 here would sit on a screen that grows with the customer base (Principle VII).
   *
   * @returns the set of `brandId|playerId` keys this manager is attached to.
   */
  async attachedAmong(
    accountId: string,
    players: readonly PlayerRef[],
    amAuthUserId: string,
  ): Promise<Set<string>> {
    if (players.length === 0) return new Set();
    const rows = (await this.prisma.forAccount(accountId).playerAssignment.findMany({
      where: {
        am_auth_user_id: amAuthUserId,
        ended_at: null,
        // One OR over the page rather than a join: the identity is a pair, and Prisma has no tuple
        // IN. The page size is clamped, so the clause is bounded.
        OR: players.map((p) => ({ brand_id: p.brandId, player_id: p.playerId })),
      },
      select: { brand_id: true, player_id: true },
    })) as Array<{ brand_id: string; player_id: string }>;
    return new Set(rows.map((r) => `${r.brand_id}|${r.player_id}`));
  }

  /** "My players" — the 9.10 portfolio list. Keyset-paged; the caller clamps the size. */
  async listActiveFor(
    accountId: string,
    amAuthUserId: string,
    limit: number,
    after?: { startedAt: Date; id: string },
  ): Promise<AssignmentRow[]> {
    return (await this.prisma.forAccount(accountId).playerAssignment.findMany({
      where: {
        am_auth_user_id: amAuthUserId,
        ended_at: null,
        // Keyset, never offset: `started_at` with `id` breaking same-instant ties, so two rows
        // created in the same millisecond still page deterministically (the feature 015 lesson).
        ...(after
          ? {
              OR: [
                { started_at: { lt: after.startedAt } },
                { started_at: after.startedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ started_at: 'desc' }, { id: 'desc' }],
      take: limit,
    })) as AssignmentRow[];
  }

  /** Every period, current and closed — "who used to look after this player". */
  async historyFor(accountId: string, player: PlayerRef): Promise<AssignmentRow[]> {
    return (await this.prisma.forAccount(accountId).playerAssignment.findMany({
      where: { brand_id: player.brandId, player_id: player.playerId },
      orderBy: [{ started_at: 'desc' }],
    })) as AssignmentRow[];
  }

  /**
   * Attach, and write the audit entry in the SAME transaction.
   *
   * The two are inseparable (feature 015): if the entry cannot be written the attachment does not
   * happen. An unaudited attach is precisely the harvesting step the audit exists to detect, so a
   * silent one is worse than a refused one.
   */
  async attach(
    accountId: string,
    input: { player: PlayerRef; amAuthUserId: string; assignedBy: string },
    recordAudit: (tx: unknown) => unknown,
  ): Promise<AssignmentRow> {
    const db = this.prisma.forAccount(accountId);
    return (await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        playerAssignment: { create(a: Record<string, unknown>): Promise<unknown> };
      };
      const row = await client.playerAssignment.create({
        data: {
          account_id: accountId,
          brand_id: input.player.brandId,
          player_id: input.player.playerId,
          am_auth_user_id: input.amAuthUserId,
          assigned_by: input.assignedBy,
        },
      });
      await recordAudit(tx);
      return row;
    })) as AssignmentRow;
  }

  /**
   * ⭐ W32 (roadmap 3.16, ADR 0043 §4) — the departing person's OPEN attachments, oldest first.
   *
   * The selection IS the idempotence: an attachment already moved no longer matches «theirs and still
   * open», so a half-finished pass simply resumes and a completed one finds nothing. That is why this
   * feature needed no «handled» flag and no second table — a flag that says «done» is one more thing
   * to keep true, and the first failed run makes it lie.
   */
  async openAssignmentsOf(
    accountId: string,
    amAuthUserId: string,
    limit: number,
  ): Promise<AssignmentRow[]> {
    return (await this.prisma.forAccount(accountId).playerAssignment.findMany({
      where: { am_auth_user_id: amAuthUserId, ended_at: null },
      orderBy: { started_at: 'asc' },
      take: limit,
    })) as AssignmentRow[];
  }

  /** How many are left beyond this pass — so the tick converges instead of holding one long lock. */
  async countOpenAssignmentsOf(accountId: string, amAuthUserId: string): Promise<number> {
    return this.prisma.forAccount(accountId).playerAssignment.count({
      where: { am_auth_user_id: amAuthUserId, ended_at: null },
    });
  }

  /**
   * ⭐ W32 — hand ONE player from one manager to another: close the old period, open the new one.
   *
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠️ **ONE TRANSACTION, AND THAT IS FORCED BY THE DATABASE — not chosen for tidiness.**
   * The partial unique index `(account_id, brand_id, player_id) WHERE ended_at IS NULL` permits
   * exactly one open period per player, so the new one cannot exist beside the old. Doing this as two
   * transactions would leave a window in which the player belongs to NOBODY — and a crash inside that
   * window would make it permanent, silently, for a customer whose manager just left.
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ Returns `false` when the row stopped being theirs between the read and the write — a human
   * reassigned them, or an earlier pass already moved them. The caller counts that as `skipped`, not
   * as moved: claiming a move we did not make would inflate the report an administrator acts on.
   *
   * Two audit entries, exactly as a human transfer writes — the history is additive and the trail must
   * say so. `recordAudit` is invoked twice, once per act, inside the same transaction as the writes.
   */
  async handOver(
    accountId: string,
    assignmentId: string,
    input: { player: PlayerRef; from: string; to: string; actorRef: string },
    recordAudit: (tx: unknown, action: 'player.assign' | 'player.unassign', manager: string) => unknown,
  ): Promise<boolean> {
    const db = this.prisma.forAccount(accountId);
    return db.$transaction(async (tx) => {
      const client = tx as unknown as {
        playerAssignment: {
          updateMany(a: Record<string, unknown>): Promise<{ count: number }>;
          create(a: Record<string, unknown>): Promise<unknown>;
        };
      };
      // ⚠️ The departing person is IN THE PREDICATE, so two racing passes cannot both close it and
      // the answer is honest about which one did.
      const closed = await client.playerAssignment.updateMany({
        where: { id: assignmentId, am_auth_user_id: input.from, ended_at: null },
        data: { ended_at: new Date(), ended_by: input.actorRef },
      });
      if (closed.count === 0) return false;

      await client.playerAssignment.create({
        data: {
          account_id: accountId,
          brand_id: input.player.brandId,
          player_id: input.player.playerId,
          am_auth_user_id: input.to,
          assigned_by: input.actorRef,
        },
      });
      await recordAudit(tx, 'player.unassign', input.from);
      await recordAudit(tx, 'player.assign', input.to);
      return true;
    });
  }

  /** Close the active period. ⚠️ Never a delete — the row survives as history (FR-003). */
  async detach(
    accountId: string,
    assignmentId: string,
    endedBy: string,
    recordAudit: (tx: unknown) => unknown,
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        playerAssignment: { update(a: Record<string, unknown>): Promise<unknown> };
      };
      await client.playerAssignment.update({
        where: { id: assignmentId },
        data: { ended_at: new Date(), ended_by: endedBy },
      });
      await recordAudit(tx);
    });
  }
}
