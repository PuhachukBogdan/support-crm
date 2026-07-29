import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Patch,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { ResolvesPermissions } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callUploads, toHttp } from '../uploads/rpc';

/**
 * The operator's own appearance settings (feature 021, roadmap 5.6).
 *
 * ⚠️ NOT `Player.preferences_json`. That is the CUSTOMER's preferences — VIP portfolio data, tier
 * `am_only`, masked from most roles. This edge carries an employee's theme and font size.
 *
 * ── Why `/me` and not `/operators/:id/ui-preferences` ────────────────────────────────────────────
 * The isolation guarantee is the ABSENCE of a parameter, not a check. With `/me` there is no path
 * segment that could name another person, so "you cannot read someone else's settings" is a property
 * of the route table rather than of a comparison a later edit could weaken. A structural test asserts
 * no route here accepts a subject.
 *
 * ── ⚠️ `@ResolvesPermissions()` and no `@RequiresPermission` — the one wiring decision here ───────
 * Reading `PermissionGuard.canActivate`:
 *
 *   • the view-as write-block runs for EVERY route with claims, *before* the not-permission-gated
 *     early return — so `PATCH` under an active preview is already refused at this tier;
 *   • but `req.effective` is populated ONLY for routes carrying permission metadata, and
 *     `buildActorMetadata` fills `x-is-preview` from exactly that.
 *
 * A route with no metadata would therefore forward NO preview marker, the owning service's
 * independent refusal could never fire, and every test would stay green because this tier already
 * covers the case. That is feature 016's live-only defect (two GET routes forwarding an empty
 * permission set) and feature 018's `x-is-preview` defect (a parameter no route ever passed), in the
 * same place. `ui-preferences.spec.ts` pins the decorator itself for that reason.
 *
 * It is NOT "no authorization": the global AuthGuard still requires a session. What is absent is a
 * PERMISSION check, because no permission gates a person's own font size (ADR 0035's hard boundary —
 * a preference may never decide what someone is allowed to see).
 *
 * ── What this edge does NOT do ───────────────────────────────────────────────────────────────────
 * It validates the SHAPE of the body and nothing else. Whether a key exists and whether a value is
 * allowed is the owning service's decision (Principle II) against the closed catalogue in
 * `@crm/common`. A second copy of those rules here is the drift feature 017 found live, where two
 * export vocabularies had already diverged before anyone noticed.
 */

interface UiPreferencesWire {
  values?: Record<string, string>;
}

interface UiPreferencesGrpc {
  getOperatorUiPreferences(d: Record<string, unknown>, md?: unknown): Observable<UiPreferencesWire>;
  updateOperatorUiPreferences(
    d: Record<string, unknown>,
    md?: unknown,
  ): Observable<UiPreferencesWire>;
}

type PrefReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Transport-shape validation only.
 *
 * A malformed body is a transport concern and belongs here; an unknown preference KEY is a catalogue
 * concern and belongs to the service. The line matters: if this function started knowing key names,
 * the catalogue would have two homes.
 */
function parsePatchBody(body: unknown): Record<string, string> {
  const values = (body as UiPreferencesWire | undefined)?.values;
  if (values === null || values === undefined || typeof values !== 'object' || Array.isArray(values))
    throw new BadRequestException('values must be an object');

  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length === 0) throw new BadRequestException('values must not be empty');

  for (const [key, value] of entries) {
    // The KEY is named; the VALUE never is. Echoing arbitrary submitted input into an error body is
    // how it reaches a log (Principle IV).
    if (typeof value !== 'string')
      throw new BadRequestException(`value must be a string for preference: ${key}`);
  }
  return values as Record<string, string>;
}

/**
 * ⚠️ A NARROW exception to the message-free error mapping — found by the live run, not offline.
 *
 * The shared `toHttp` is deliberately message-free: "the client learns the CLASS of failure and never
 * the downstream detail" (feature 016), because an uploads error could otherwise carry a filename or
 * a storage key. That rule is right and stays.
 *
 * But it also swallowed the one detail this surface needs. The owning service refuses a bad
 * preference with `value not allowed for preference: theme_mode`, and the client received
 * `{"message":"invalid request"}` — so a settings screen could not say WHICH control is wrong. Every
 * offline test passed, because they assert the service's exception and never cross the edge. Fourth
 * occurrence of the wire-between-the-tiers class (4.9, 5.1, 5.2, and now this).
 *
 * The pass-through is safe **here specifically**, and only because of what the service guarantees
 * about the message: it never contains a submitted VALUE, and it never contains an unknown KEY (which
 * would be caller input). What it can contain is a catalogue literal — a name that is already public
 * in shape. `boundary.spec.ts` and the controller spec pin both halves at the service tier; if either
 * ever stops holding, this pass-through becomes a reflection point.
 *
 * Scoped to `INVALID_ARGUMENT`. Every other class still goes through the coarse shared mapping.
 */
function toHttpNamingTheKey(err: unknown): Error {
  const mapped = toHttp(err);
  if (!(mapped instanceof BadRequestException)) return mapped;
  const detail = (err as { details?: string; message?: string })?.details ?? (err as Error)?.message;
  return typeof detail === 'string' && detail.length > 0 && detail.length < 200
    ? new BadRequestException(detail)
    : mapped;
}

@Controller()
export class UiPreferencesEdgeController implements OnModuleInit {
  private prefs!: UiPreferencesGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    // The EXISTING users client. A second registration would open a second connection to the same
    // service for no reason.
    this.prefs = this.client.getService<UiPreferencesGrpc>('OperatorUiPreferencesService');
  }

  private meta(req: PrefReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  /** Always the complete set. Never a 404 — a person who has never chosen anything gets defaults. */
  @Get('me/ui-preferences')
  @ResolvesPermissions()
  async get(@Req() req: PrefReq): Promise<UiPreferencesWire> {
    return callUploads(this.prefs.getOperatorUiPreferences({}, this.meta(req)));
  }

  /**
   * `PATCH`, not `PUT`: the body is a partial set of keys, and `PUT` would advertise whole-record
   * replacement. `PATCH` is in the guard's mutating set, which is what makes the view-as write-block
   * apply to it.
   */
  @Patch('me/ui-preferences')
  @ResolvesPermissions()
  async patch(@Body() body: unknown, @Req() req: PrefReq): Promise<UiPreferencesWire> {
    const values = parsePatchBody(body);
    try {
      // ⚠️ `firstValueFrom`, not `callUploads`, and that is the whole repair: `callUploads` maps the
      // error itself, so by the time a caller could inspect it the downstream detail is already gone.
      // Wrapping its output would have "named the key" as the literal string `invalid request`.
      return await firstValueFrom(
        this.prefs.updateOperatorUiPreferences({ values }, this.meta(req)),
      );
    } catch (err) {
      throw toHttpNamingTheKey(err);
    }
  }
}
