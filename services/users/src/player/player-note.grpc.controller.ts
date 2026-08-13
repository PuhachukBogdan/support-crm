import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  PlayerNoteService,
  type AddNoteOutcome,
  type ReadableNote,
} from './player-note.service';

/**
 * `PlayerNotesService` — the notes surface (W35 / feature 040, R35 · U17).
 *
 * A separate gRPC service from `UsersReadService` for the reason the assignment controller states: a
 * write on a service named *Read* is a lie in the contract, and a guard enforces it. New service,
 * EXISTING package ⇒ no new hosting entry.
 *
 * ⚠️ **Both tiers check, always.** The gateway carries the permission metadata; this handler re-reads it
 * and refuses on its own authority, so a call that skips the edge is refused on the same grounds
 * (feature 011's two-tier rule). The *clearance* — whether this caller may see this customer's notes at
 * all — is the SERVICE's decision and lives one layer down, in the one gate
 * (`assertCanReadPlayerNotes`).
 *
 * ⚠️ **Writing is refused under a view-as preview; reading is not.** A preview exists to show what
 * another role SEES, so reading through it is the feature working — and the masking input is already the
 * previewed role. Writing through it would leave a real, signed, unremovable row authored by somebody
 * who was pretending, which is not a read-only preview. Features 024, 025 and 026 draw the same line.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

/** The write key. Declared by feature 011 and, until this feature, enforced by nothing at all. */
const WRITE_KEY = 'users.am_notes.edit';

/**
 * ⚠️ The key KEEPS its name although "edit" is now "add", and that is a decision rather than laziness.
 *
 * A permission key is a stored identity: it sits in role templates and in granted rows. Role templates
 * are **not retroactive** (W27's stand lesson — a new key means re-seeding auth), so renaming this one
 * would silently drop the capability for everybody who already holds it, on a screen where the failure
 * looks like "the button does nothing". Only its LABEL changed.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const may = (md: Metadata | undefined, key: string): boolean =>
  readStr(md, 'x-actor-permissions')
    .split(',')
    .map((s) => s.trim())
    .includes(key);

const forbidden = () =>
  new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });

/**
 * ⚠️ Outcomes are encoded by NAME, not by tag.
 *
 * proto-loader runs with `enums: String`, so a response carries `"ADD_NOTE_OUTCOME_STORED"` and not `1`.
 * Feature 025 lost a live iteration to exactly this: writes kept working while reads broke, and every
 * unit test stayed green (`gotchas/grpc-wire-encoding-enums-longs`, twice).
 */
const OUTCOME = {
  stored: 'ADD_NOTE_OUTCOME_STORED',
  needs_acknowledgement: 'ADD_NOTE_OUTCOME_NEEDS_ACK',
  empty_body: 'ADD_NOTE_OUTCOME_EMPTY_BODY',
  too_long: 'ADD_NOTE_OUTCOME_TOO_LONG',
  no_such_player: 'ADD_NOTE_OUTCOME_NO_SUCH_PLAYER',
} as const;

interface NotesWire {
  brandId?: string;
  playerId?: string;
  body?: string;
  acknowledged?: boolean;
  clientRef?: string;
  /** ⚠️ Arrives as a NUMBER or as a numeric string depending on the caller; normalised below. */
  pageSize?: number | string;
}

/**
 * Row → wire, field by field.
 *
 * ⚠️ An EXPLICIT projection, never a spread. `tier-agreement.spec.ts` enforces that rule for the player
 * row and the reason applies unchanged here: a column added to the table must not reach a client because
 * nobody remembered this file. `client_ref` is deliberately absent — it is the caller's own idempotence
 * bookkeeping and means nothing to a reader.
 */
const toNoteWire = (note: ReadableNote) => ({
  id: note.id,
  body: note.body,
  authorRef: note.author_auth_user_id,
  authorDisplayName: note.author_display_name,
  createdAt: note.created_at.toISOString(),
  patternKinds: note.pattern_kinds ? note.pattern_kinds.split(',') : [],
});

@Controller()
export class PlayerNotesController {
  constructor(@Inject(PlayerNoteService) private readonly notes: PlayerNoteService) {}

  @GrpcMethod('PlayerNotesService', 'ListPlayerNotes')
  async listPlayerNotes(req: NotesWire, metadata: Metadata) {
    const ctx = this.caller(metadata);
    const player = this.player(req);
    // ⚠️ A missing brand is a REFUSAL, not an empty page: a platform id alone names two customers, so
    // there is no record to answer about. Answering `{notes: []}` would claim a fact about whichever
    // customer the caller had in mind.
    if (!player) throw forbidden();

    // A non-numeric or negative ask degrades to "you decide" rather than to an error: the size is a
    // hint, and the service caps it either way.
    const asked = Number(req?.pageSize ?? 0);
    const rows = await this.notes.list(
      ctx.accountId,
      player,
      ctx,
      Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0,
    );
    return { notes: rows.map(toNoteWire) };
  }

  @GrpcMethod('PlayerNotesService', 'AddPlayerNote')
  async addPlayerNote(req: NotesWire, metadata: Metadata) {
    const ctx = this.caller(metadata);
    // Both tiers. The clearance is checked deeper (the service's gate); THIS is the permission.
    if (!may(metadata, WRITE_KEY)) throw forbidden();
    // A preview may not leave a signed row behind.
    if (readStr(metadata, 'x-is-preview') === 'true') throw forbidden();

    const player = this.player(req);
    if (!player) return { outcome: OUTCOME.no_such_player };

    const outcome = await this.notes.add(
      ctx.accountId,
      player,
      {
        body: req?.body ?? '',
        acknowledged: req?.acknowledged === true,
        clientRef: (req?.clientRef ?? '').trim(),
      },
      ctx,
    );
    return this.reply(outcome);
  }

  /**
   * The caller. Refuses before anything else when there is no account context — with no tenant there is
   * nothing to scope a read to and nothing to attribute a row to (Principle I, fail-closed).
   *
   * `effectiveRole` is passed through UNCHANGED, empty included: the policy treats an unknown role as
   * open-only, so absence degrades to the most restricted answer by itself. Substituting a default here
   * would be a privilege decision made in a metadata reader (`player/actor.ts` states the rule).
   */
  private caller(metadata: Metadata): {
    accountId: string;
    userId: string;
    effectiveRole: string;
  } {
    const accountId = readStr(metadata, 'x-actor-account-id');
    if (!accountId) throw forbidden();
    return {
      accountId,
      userId: readStr(metadata, 'x-actor-user-id'),
      effectiveRole: readStr(metadata, 'x-actor-effective-role'),
    };
  }

  /** The full identity, or nothing. There is no overload taking a bare `player_id` (feature 020). */
  private player(req: NotesWire): { brandId: string; playerId: string } | null {
    const brandId = (req?.brandId ?? '').trim();
    const playerId = (req?.playerId ?? '').trim();
    return brandId && playerId ? { brandId, playerId } : null;
  }

  /** One shape per outcome — no branch collapses two different answers into one. */
  private reply(outcome: AddNoteOutcome) {
    switch (outcome.status) {
      case 'stored':
        return {
          outcome: OUTCOME.stored,
          note: toNoteWire(outcome.note),
          replayed: outcome.replayed,
        };
      case 'needs_acknowledgement':
        // ⚠️ Nothing was stored, and the answer says WHAT was recognised — never a fragment of the text.
        return { outcome: OUTCOME.needs_acknowledgement, patternKinds: outcome.kinds };
      case 'empty_body':
        return { outcome: OUTCOME.empty_body };
      case 'too_long':
        return { outcome: OUTCOME.too_long };
      default:
        return { outcome: OUTCOME.no_such_player };
    }
  }
}
