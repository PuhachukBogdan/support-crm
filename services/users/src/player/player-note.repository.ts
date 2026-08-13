import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { PlayerRef } from '../assignment/assignment.repository';

/**
 * Player-note persistence (W35 / feature 040 — R35, U17).
 *
 * ⚠️ **THERE IS NO UPDATE, NO DELETE AND NO UPSERT IN THIS FILE, AND THAT IS THE FEATURE.**
 *
 * Q20 settled it with a scenario rather than a preference: *«вписал, показал кому надо, стёр, и в
 * системе чисто»* — if a note can be edited, the edit trail has to be kept, or the note becomes a way
 * to show somebody something and then make it never have happened. Append-only removes the move
 * instead of policing it, and it does so without a revision store.
 *
 * The absence is enforced three ways, deliberately overlapping, because a comment is not a control:
 *   1. the TABLE has no mutable column (no `updated_at`, no `revision`, no `deleted_at`);
 *   2. the CONTRACT declares exactly two rpcs — there is no verb to call;
 *   3. `notes-append-only.spec.ts` scans this service's source and fails if a mutation names the model.
 *
 * `forAccount` on every access, without exception — the rule the assignment repository states next
 * door: it makes *"not yours"* and *"does not exist"* the same query result rather than two branches a
 * later edit could separate.
 *
 * ⚠️ **The player is `(account, brand, player_id)`.** No method here takes a bare `player_id`; the
 * missing overload is the guarantee (feature 020 — the same platform id under two brands is routinely
 * two different human beings).
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface PlayerNoteRow {
  id: string;
  brand_id: string;
  player_id: string;
  body: string;
  author_auth_user_id: string;
  pattern_kinds: string;
  created_at: Date;
}

/** What `append` needs. `clientRef` is the idempotence key — never the body (spec FR-012). */
export interface NewNote {
  player: PlayerRef;
  body: string;
  authorAuthUserId: string;
  patternKinds: string;
  clientRef: string;
}

const SELECT = {
  id: true,
  brand_id: true,
  player_id: true,
  body: true,
  author_auth_user_id: true,
  pattern_kinds: true,
  created_at: true,
} as const;

@Injectable()
export class PlayerNoteRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * This player's notes, newest first.
   *
   * `limit` is clamped by the caller. Ordered by `created_at` then `id`, so two notes written in the
   * same millisecond still order deterministically — the feature-015 lesson, applied here because the
   * list is what a successor reads after a handover and a flickering order would look like edits.
   */
  async listForPlayer(
    accountId: string,
    player: PlayerRef,
    limit: number,
  ): Promise<PlayerNoteRow[]> {
    return (await this.prisma.forAccount(accountId).playerNote.findMany({
      where: { brand_id: player.brandId, player_id: player.playerId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SELECT,
    })) as PlayerNoteRow[];
  }

  /** An earlier note with this idempotence reference, if the caller is retrying. */
  async findByClientRef(accountId: string, clientRef: string): Promise<PlayerNoteRow | null> {
    return (await this.prisma.forAccount(accountId).playerNote.findFirst({
      where: { client_ref: clientRef },
      select: SELECT,
    })) as PlayerNoteRow | null;
  }

  /**
   * Add a note — and, when it is flagged, write its audit entry **in the same transaction**.
   *
   * ⚠️ The audit callback is not a convenience. Feature 015's rule is that an entry lives inside its
   * action's transaction: if the entry cannot be written the note does not exist, because a flagged note
   * with no record of the warning is precisely the state R35 exists to prevent. The callback shape is
   * the assignment repository's, unchanged — one pattern for "the act and its record are one write".
   *
   * `writeAudit` is `undefined` for an ordinary note, and that is the whole difference between the two
   * paths: no entry, no branch inside the transaction, nothing to forget.
   */
  async append(
    accountId: string,
    note: NewNote,
    writeAudit?: (tx: unknown) => Promise<void>,
  ): Promise<PlayerNoteRow> {
    const db = this.prisma.forAccount(accountId);
    return (await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        playerNote: { create(a: Record<string, unknown>): Promise<PlayerNoteRow> };
      };
      const row = await client.playerNote.create({
        data: {
          account_id: accountId,
          brand_id: note.player.brandId,
          player_id: note.player.playerId,
          body: note.body,
          author_auth_user_id: note.authorAuthUserId,
          pattern_kinds: note.patternKinds,
          client_ref: note.clientRef,
        },
        select: SELECT,
      });
      if (writeAudit) await writeAudit(tx);
      return row;
    })) as PlayerNoteRow;
  }
}
