import { Inject, Injectable } from '@nestjs/common';
import { buildEntry } from '@crm/common';
import {
  AssignmentRepository,
  type AssignmentRow,
  type PlayerRef,
} from './assignment.repository';
import { PlayerRepository } from '../player/player.repository';
import { OperatorRepository } from '../operator/operator.repository';

/**
 * Player ↔ AM attachment, the decisions (feature 026, roadmap 5.7).
 *
 * The repository stores; this decides **whether** an act happens at all — and every refusal here has
 * its own outcome rather than a shared one, because *"you may not"*, *"there is no such player"*,
 * *"that manager has left"* and *"somebody else already has them"* send an administrator looking in
 * four different places.
 *
 * ⚠️ **Attachment grants access**, so the audit entry rides the same transaction as the act
 * (feature 015): if it cannot be written, the attachment does not happen. An unaudited attach is the
 * harvesting step the trail exists to detect.
 */

export type AssignmentOutcome =
  | { status: 'ok'; assignment: AssignmentRow }
  | { status: 'unchanged'; assignment: AssignmentRow | null }
  | { status: 'no_such_player' }
  | { status: 'no_such_manager' }
  | { status: 'already_assigned'; assignment: AssignmentRow };

@Injectable()
export class AssignmentService {
  constructor(
    @Inject(AssignmentRepository) private readonly repo: AssignmentRepository,
    @Inject(PlayerRepository) private readonly players: PlayerRepository,
    @Inject(OperatorRepository) private readonly operators: OperatorRepository,
  ) {}

  /** Who looks after this player right now? */
  async activeFor(accountId: string, player: PlayerRef): Promise<AssignmentRow | null> {
    return this.repo.activeFor(accountId, player);
  }

  /**
   * Attach a player to a manager.
   *
   * `amAuthUserId` empty ⇒ the caller themselves. **Self-assignment is a requirement**, not a
   * tolerated case (FR-008), and defaulting the field is what makes the common act the easy one.
   */
  async assign(
    accountId: string,
    player: PlayerRef,
    amAuthUserId: string,
    actorUserId: string,
  ): Promise<AssignmentOutcome> {
    const manager = amAuthUserId || actorUserId;

    // Order matters. The player check comes first so that a caller probing for ids learns nothing
    // about which managers exist, and vice versa.
    if (!(await this.playerExists(accountId, player))) return { status: 'no_such_player' };

    // ⚠️ The manager is stored as an AUTH identity (research R1), but an ACTIVE operator profile
    // must exist for it. An attachment to somebody who has left the company would be a portfolio
    // nobody is looking after while the record claims otherwise (FR-005). One lookup on the WRITE
    // path; none on the read path, which is the right way round.
    const profiles = await this.operators.resolveByAuthUserIds(accountId, [manager]);
    if (profiles.length === 0) return { status: 'no_such_manager' };

    const existing = await this.repo.activeFor(accountId, player);
    if (existing) {
      // Already this manager: nothing changed, and nothing is recorded. A no-op that wrote an entry
      // would inflate the abnormal-volume signal at its source — and that signal is the whole
      // control on self-assignment.
      if (existing.am_auth_user_id === manager) return { status: 'unchanged', assignment: existing };
      // ⭐ Somebody ELSE has them: refused, never silently replaced. The 🅿 one-active-manager
      // constraint is only visible if breaking it says so, and a caller who means to move the player
      // unassigns first — deliberately, as two audited acts.
      return { status: 'already_assigned', assignment: existing };
    }

    const row = await this.repo.attach(
      accountId,
      { player, amAuthUserId: manager, assignedBy: actorUserId },
      (tx) => this.writeAudit(tx, accountId, 'player.assign', player, manager, actorUserId),
    );
    return { status: 'ok', assignment: row };
  }

  /** Detach whoever currently holds the player. Closing a period, never deleting one. */
  async unassign(
    accountId: string,
    player: PlayerRef,
    actorUserId: string,
  ): Promise<AssignmentOutcome> {
    if (!(await this.playerExists(accountId, player))) return { status: 'no_such_player' };

    const existing = await this.repo.activeFor(accountId, player);
    // Nothing to do is not an error, and it records nothing.
    if (!existing) return { status: 'unchanged', assignment: null };

    await this.repo.detach(accountId, existing.id, actorUserId, (tx) =>
      this.writeAudit(tx, accountId, 'player.unassign', player, existing.am_auth_user_id, actorUserId),
    );
    return { status: 'ok', assignment: { ...existing, ended_at: new Date(), ended_by: actorUserId } };
  }

  private async playerExists(accountId: string, player: PlayerRef): Promise<boolean> {
    // Through the account-scoped read, so a player from another account is indistinguishable from
    // one that does not exist — the caller learns nothing either way.
    const row = await this.players.getPlayer({
      accountId,
      brandId: player.brandId,
      playerId: player.playerId,
    });
    return row !== null;
  }

  /**
   * The audit entry, inside the act's own transaction.
   *
   * ⚠️ `targetRef` is the PLAYER and `actorUserId` is who decided — and for a self-assignment the
   * manager is the actor. All three facts are needed to answer *"who attached a hundred players to
   * themselves this hour?"*, which is the question FR-016 exists for.
   *
   * Detail carries ids and enums only. The allow-list for this class refuses anything else, so a
   * player's name or a note's text cannot arrive here even by accident.
   */
  private async writeAudit(
    tx: unknown,
    accountId: string,
    action: 'player.assign' | 'player.unassign',
    player: PlayerRef,
    amAuthUserId: string,
    actorUserId: string,
  ): Promise<void> {
    const data = buildEntry({
      action,
      actorUserId,
      // The subject of the act is the PLAYER — a full identity, because a bare platform id names two
      // people (feature 020).
      targetRef: `${player.brandId}:${player.playerId}`,
      // ⭐ `selfAssigned` and `managerRef` — the two keys feature 015 RESERVED for this class, long
      // before this feature existed. `selfAssigned` is exactly the flag the abnormal-volume question
      // wants: "who attached a hundred players TO THEMSELVES this hour?" is the harvesting pattern,
      // and 015 anticipated it. Using the reserved keys rather than inventing one is why the
      // allow-list refuses anything else.
      detail: { selfAssigned: String(amAuthUserId === actorUserId), managerRef: amAuthUserId },
    });
    await (
      tx as { auditEntry: { create(a: Record<string, unknown>): Promise<unknown> } }
    ).auditEntry.create({
      data: { account_id: accountId, ...data, detail_json: data.detail_json ?? undefined },
    });
  }
}
