import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callUploads } from '../uploads/rpc';
import {
  parseNotesListQuery,
  parseAddNoteBody,
  toNotePageResponse,
  toNoteResponse,
  outcomeWord,
} from './wire';

/**
 * ⭐ W35 / feature 040 — the player-notes edge (R35 · U17).
 *
 * ── ⚠️ WHY THIS IS ITS OWN CONTROLLER, and it is not tidiness ────────────────────────────────────
 * The routes were first written into `players.controller.ts` beside the card reads, and
 * `tests/users-read/no-outbound.spec.ts` refused it on the root run — correctly. That file is
 * feature 018's READ edge and FR-027 is a property of it: *there is no write surface*, and the guard
 * says in as many words that «a `@Post` appearing here would be the defect». It is a guarantee about
 * the customer-read surface worth keeping, so the write moved out rather than the guard being widened.
 *
 * Both notes routes live here, read included: they are ONE surface with one contract, and splitting
 * the GET from the POST would put half of a feature in a file whose stated property it does not share.
 *
 * ── The division of labour, restated because it decides what may live here ───────────────────────
 * The edge authorizes the CALL; the owning service shapes the ANSWER. `crm.contact.view` is the door
 * on the read — everybody who can open a customer card holds it — and who may actually read the notes
 * is the `am_only` clearance ABOUT THIS PLAYER, decided in `users`. This controller holds no policy
 * (Principle II): a per-record rule in the tier least able to know the record is a rule that will be
 * wrong.
 */
type NotesReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

interface PlayerNotesGrpc {
  listPlayerNotes(d: Record<string, unknown>, md?: unknown): Observable<{ notes?: unknown[] }>;
  addPlayerNote(
    d: Record<string, unknown>,
    md?: unknown,
  ): Observable<{ outcome?: unknown; note?: unknown; patternKinds?: unknown[]; replayed?: boolean }>;
}

@Controller()
export class PlayerNotesController implements OnModuleInit {
  private notes!: PlayerNotesGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    // The EXISTING users client — a second registration would open a second connection to one process.
    // A new gRPC SERVICE in the same package needs no new client and no new hosting entry.
    this.notes = this.client.getService<PlayerNotesGrpc>('PlayerNotesService');
  }

  private meta(req: NotesReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  /**
   * What somebody wrote about this customer, newest first.
   *
   * ⚠️ A refusal arrives as a 403 carrying `forbidden` and NOTHING about the notes — not their number,
   * not whether any exist. "How many notes does this customer have" is itself an answer about a
   * customer, which is why the owning service refuses rather than returning an empty page.
   */
  @Get('players/:playerId/notes')
  @RequiresPermission('crm.contact.view')
  async listPlayerNotes(
    @Param('playerId') playerId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: NotesReq,
  ): Promise<{ notes: Record<string, unknown>[] }> {
    // The brand is REQUIRED, refused before the call: a platform id alone names two customers, so there
    // is no correct record to answer about — only a lucky one (the same rule as the card read).
    //
    // ⚠️ `pageSize` is ACCEPTED because the browser's transport always sends it — the live run found this
    // route answering 400 to every real read (see `parseNotesListQuery`). It is forwarded and CLAMPED by
    // the owning service rather than ignored here.
    const { brandId, pageSize } = parseNotesListQuery(query);
    return toNotePageResponse(
      await callUploads(this.notes.listPlayerNotes({ playerId, brandId, pageSize }, this.meta(req))),
    );
  }

  /**
   * Add a note — or be told what the text contains first.
   *
   * ── The two-step is the feature, not a validation failure ───────────────────────────────────────
   * A note is the one place a customer's withheld phone number can be retyped in clear (R35), so the
   * body is examined server-side. When something is recognised and the caller has not acknowledged it,
   * the answer is **200 `needs_acknowledgement`** and nothing is stored; the same request with
   * `acknowledged: true` stores the note, and the trail records that somebody was shown what was in the
   * text and proceeded anyway.
   *
   * ⚠️ **A 200 and not a 4xx**, deliberately. It is the product answering a question, not refusing —
   * the note IS storable (U17: nothing is unstorable, a hard block is defeated by rephrasing). A 4xx
   * would push clients into error handling on the commonest teaching moment, and the one thing that
   * must not happen there is losing the author's typed text.
   */
  @Post('players/:playerId/notes')
  @RequiresPermission('users.am_notes.edit')
  @HttpCode(200)
  async addPlayerNote(
    @Param('playerId') playerId: string,
    @Body() body: unknown,
    @Req() req: NotesReq,
  ): Promise<Record<string, unknown>> {
    const input = parseAddNoteBody(body);
    const res = await callUploads(
      this.notes.addPlayerNote(
        {
          playerId,
          brandId: input.brandId,
          body: input.body,
          acknowledged: input.acknowledged,
          clientRef: input.clientRef,
        },
        this.meta(req),
      ),
    );

    const outcome = outcomeWord(res?.outcome);
    switch (outcome) {
      case 'stored':
        return { outcome, note: toNoteResponse(res?.note), replayed: res?.replayed === true };
      case 'needs_acknowledgement':
        // The kinds, never a fragment of the text. The client shows the warning and keeps the body.
        return { outcome, patternKinds: (res?.patternKinds ?? []).map(String) };
      case 'empty_body':
      case 'too_long':
        // 422: understood, and the content is not acceptable. ⚠️ The message names the OUTCOME and never
        // quotes the body (SEC-26 — a note can contain the very value this feature exists to notice, and
        // an error message is the most-copied string in any system).
        throw new UnprocessableEntityException(outcome);
      case 'no_such_player':
        throw new NotFoundException('not found');
      default:
        // ⚠️ An unrecognised outcome — including the zero value the wire drops — is an upstream error,
        // NEVER a success. `gotchas/grpc-wire-encoding-enums-longs`, the third time this bites.
        throw new InternalServerErrorException('upstream error');
    }
  }
}
