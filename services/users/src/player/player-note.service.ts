import { Inject, Injectable } from '@nestjs/common';
import {
  buildEntry,
  contactShapedKinds,
  patternKindsDetail,
  type ContactPatternKind,
} from '@crm/common';
import { PlayerNoteRepository, type PlayerNoteRow } from './player-note.repository';
import { PlayerRepository } from './player.repository';
import { OperatorRepository } from '../operator/operator.repository';
import { AssignmentRepository, type PlayerRef } from '../assignment/assignment.repository';
import { assertCanReadPlayerNotes } from './player.masking';

/**
 * Player notes — the decisions (W35 / feature 040, R35 · U17).
 *
 * The repository stores; this decides **whether**, and **what the author is told first**.
 *
 * ── The order of the checks is the design ────────────────────────────────────────────────────────
 *   1. **clearance** — may this caller see this player's notes at all (the `am_only` question about
 *      this record, asked through the ONE gate in `player.masking.ts`);
 *   2. **the player exists** — through the account-scoped read, so another tenant's player is
 *      indistinguishable from a missing one;
 *   3. **the body is a body** — non-empty, within bounds;
 *   4. **the detector** — and if it fires and the caller has not acknowledged it, STOP: store nothing,
 *      answer with the kinds.
 *
 * Clearance first, deliberately: every later step leaks something. "No such player" tells a caller
 * which ids exist; a detector verdict tells them what shapes we look for. Neither is available to
 * somebody who may not read this customer's notes in the first place.
 *
 * ── ⚠️ Why the warning is a ROUND TRIP and not a client-side check ───────────────────────────────
 * `web/` imports nothing from `@crm/common` by standing rule, so a browser-side detector would be a
 * SECOND implementation of a security rule — the divergence-with-a-delay-fuse that
 * `single-policy-path.spec.ts` exists to prevent, in a place where the two copies would be a regex
 * each. So the first Add answers *what was found* and stores nothing; the same request carrying the
 * acknowledgement stores it.
 *
 * That is **not** a block, and U17's reasoning survives intact: no body is unstorable, and the author
 * who means to add a phone number adds it. What changes is that the trail records a DELIBERATE act —
 * somebody was shown what was in the text and proceeded — which is stronger evidence than a
 * system noticing afterwards.
 */

/** 4 000 characters. A note is prose; anything longer is an import channel wearing a note's clothes. */
export const MAX_NOTE_LENGTH = 4_000;

/** How many notes one read returns. The list is a card section, not an archive. */
export const NOTE_PAGE_LIMIT = 50;

export type AddNoteOutcome =
  // ⓘ The stored note comes back READABLE — author name resolved — so the screen can prepend exactly
  // what it will show after the next read. Returning the bare row would have made a just-added note the
  // only one on the list showing a reference instead of a name until a refresh.
  | { status: 'stored'; note: ReadableNote; replayed: boolean }
  | { status: 'needs_acknowledgement'; kinds: ContactPatternKind[] }
  | { status: 'empty_body' }
  | { status: 'too_long' }
  | { status: 'no_such_player' };

/** A note plus the author's display name, resolved for the reader. */
export interface ReadableNote extends PlayerNoteRow {
  /** Empty when no operator profile resolves — the caller then shows the reference (FR-003). */
  author_display_name: string;
}

@Injectable()
export class PlayerNoteService {
  constructor(
    @Inject(PlayerNoteRepository) private readonly notes: PlayerNoteRepository,
    @Inject(PlayerRepository) private readonly players: PlayerRepository,
    @Inject(OperatorRepository) private readonly operators: OperatorRepository,
    @Inject(AssignmentRepository) private readonly assignments: AssignmentRepository,
  ) {}

  /**
   * This player's notes, newest first, each with its author's name.
   *
   * ⚠️ Refuses rather than returning an empty list. An empty list is an ANSWER — *"nobody has written
   * anything about this customer"* — and giving that answer to somebody who may not read the notes
   * would disclose a fact about a customer to a caller with no clearance for it. Absent, not empty.
   */
  async list(
    accountId: string,
    player: PlayerRef,
    caller: { userId: string; effectiveRole: string },
    /**
     * What the caller asked for, `0` for «you decide». CLAMPED here and never trusted: the cap is the
     * product's (Principle VII), and a caller asking for ten thousand notes gets one page.
     *
     * ⚠️ Honoured rather than ignored. Accepting a parameter and quietly disregarding it teaches a client
     * that it is advisory — the silently-dropped-filter shape feature 017's live run found — and this one
     * arrives on every read the browser makes.
     */
    pageSize = 0,
  ): Promise<ReadableNote[]> {
    await this.assertClearance(accountId, player, caller);

    const limit = pageSize > 0 ? Math.min(pageSize, NOTE_PAGE_LIMIT) : NOTE_PAGE_LIMIT;
    const rows = await this.notes.listForPlayer(accountId, player, limit);
    return this.withAuthorNames(accountId, rows);
  }

  /**
   * Add a note. One call, five possible answers, and only one of them writes.
   *
   * ⚠️ Idempotent by `clientRef` and never by body: two identical observations on different days are
   * two facts. A replay returns the FIRST row — and says so, so the caller can tell "stored now" from
   * "already stored" without comparing timestamps.
   */
  async add(
    accountId: string,
    player: PlayerRef,
    input: { body: string; acknowledged: boolean; clientRef: string },
    caller: { userId: string; effectiveRole: string },
  ): Promise<AddNoteOutcome> {
    await this.assertClearance(accountId, player, caller);

    if (!(await this.playerExists(accountId, player))) return { status: 'no_such_player' };

    const body = input.body.trim();
    if (!body) return { status: 'empty_body' };
    if (body.length > MAX_NOTE_LENGTH) return { status: 'too_long' };

    // The replay check comes BEFORE the detector: a retried flagged note must not ask its author to
    // acknowledge the same warning twice, and it must not write a second audit entry for one act.
    if (input.clientRef) {
      const existing = await this.notes.findByClientRef(accountId, input.clientRef);
      if (existing) {
        const [readable] = await this.withAuthorNames(accountId, [existing]);
        return { status: 'stored', note: readable!, replayed: true };
      }
    }

    const kinds = contactShapedKinds(body);
    if (kinds.length > 0 && !input.acknowledged) {
      return { status: 'needs_acknowledgement', kinds };
    }

    const patternKinds = patternKindsDetail(kinds);
    const row = await this.notes.append(
      accountId,
      {
        player,
        body,
        authorAuthUserId: caller.userId,
        patternKinds,
        clientRef: input.clientRef,
      },
      // ⚠️ The audit callback exists ONLY for a flagged note, and an ordinary one passes `undefined`
      // rather than a callback that decides to do nothing. The catalogue entry states why an ordinary
      // note writes nothing: the row is append-only and signed, so it is already its own record.
      kinds.length > 0
        ? (tx) => this.writeFlaggedAudit(tx, accountId, player, caller.userId, patternKinds)
        : undefined,
    );
    const [readable] = await this.withAuthorNames(accountId, [row]);
    return { status: 'stored', note: readable!, replayed: false };
  }

  /**
   * The clearance gate — the `am_only` question about THIS record.
   *
   * ⚠️ The attachment comes from the ONE attachment read the masked player read uses. A second query
   * with its own idea of "attached" is how two mechanisms end up deciding access, and ADR 0039 §2
   * forbids exactly that.
   *
   * ⓘ An ADMINISTRATOR is cleared by role and needs no attachment, which is the policy's own
   * derivation (`masked_pii` IS the administrative clearance) rather than a rule restated here.
   */
  private async assertClearance(
    accountId: string,
    player: PlayerRef,
    caller: { userId: string; effectiveRole: string },
  ): Promise<void> {
    const attachedToSubject = caller.userId
      ? await this.assignments.isAttached(accountId, player, caller.userId)
      : false;
    assertCanReadPlayerNotes(caller.effectiveRole, { attachedToSubject });
  }

  /** Through the account-scoped read: another tenant's player answers exactly like a missing one. */
  private async playerExists(accountId: string, player: PlayerRef): Promise<boolean> {
    const row = await this.players.getPlayer({
      accountId,
      brandId: player.brandId,
      playerId: player.playerId,
    });
    return row !== null;
  }

  /**
   * Author names, in ONE query for the whole page.
   *
   * ⚠️ Never one lookup per note (Principle VII): this list is read on the busiest customer surface in
   * the product, and the assignment repository's own comment states the same rule for the same reason.
   *
   * ⚠️ The stored identity is an AUTH user id, and the translation is `namesByAuthUserIds` — **not**
   * `resolveByAuthUserIds`, which filters to ACTIVE operators because it answers "who can take this
   * work?". Using it here would have left every note by a departed colleague unattributed, in exactly
   * the scenario the block exists for: W32 hands the portfolio over when somebody leaves. (And W31 is
   * the reminder that an auth id is not an `Operator.id` — one translation, in one place.)
   */
  private async withAuthorNames(
    accountId: string,
    rows: PlayerNoteRow[],
  ): Promise<ReadableNote[]> {
    const refs = [...new Set(rows.map((r) => r.author_auth_user_id).filter(Boolean))];
    const profiles = refs.length ? await this.operators.namesByAuthUserIds(accountId, refs) : [];
    const nameByRef = new Map(profiles.map((p) => [p.authUserId, p.displayName]));
    return rows.map((row) => ({
      ...row,
      // Empty, not "Unknown": the author of record is the reference, and a placeholder NAME would
      // invent a person. The screen shows the reference instead (FR-003's third scenario).
      author_display_name: nameByRef.get(row.author_auth_user_id) ?? '',
    }));
  }

  /**
   * The audit entry for a note whose author was warned and proceeded.
   *
   * `target_ref` is the `brand:player` PAIR — a bare platform id names two customers (the 07-29 Person
   * repair). Detail is `patternKinds` and nothing else: the KINDS are recordable, the matched text is
   * not, and the body is inexpressible here at any length (`detail.ts` refuses prose AND anything
   * PII-shaped, so this cannot be got wrong quietly).
   */
  private async writeFlaggedAudit(
    tx: unknown,
    accountId: string,
    player: PlayerRef,
    actorUserId: string,
    patternKinds: string,
  ): Promise<void> {
    const data = buildEntry({
      action: 'player.note_flagged',
      actorUserId,
      targetRef: `${player.brandId}:${player.playerId}`,
      detail: { patternKinds },
    });
    await (
      tx as { auditEntry: { create(a: Record<string, unknown>): Promise<unknown> } }
    ).auditEntry.create({
      data: { account_id: accountId, ...data, detail_json: data.detail_json ?? undefined },
    });
  }
}
