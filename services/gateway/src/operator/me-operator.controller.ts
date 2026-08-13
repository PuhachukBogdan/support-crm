import { Controller, Get, Inject, OnModuleInit, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { ResolvesPermissions } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callUploads } from '../uploads/rpc';

/**
 * ⭐ "Which operator am I?" — the self-scoped operator read (roadmap 5.11, MVP block W5).
 *
 * ── The gap this closes ──────────────────────────────────────────────────────────────────────────
 * The browser holds only the AUTH identity (who signed in), while every assignment in the product
 * points at `Operator.id` — a row in a different service's database. Until this route, nothing an
 * ordinary agent may call could translate one into the other: the only existing translation
 * (`ListOperatorsByAuthUsers`) is gated by `crm.conversation.assign`, a staffing key a line agent does
 * not hold. So the Inbox could not build "Your work" and the agent rail (4.19) had no subject.
 *
 * ── Why this is a call to ENSURE and not to a getter ────────────────────────────────────────────
 * W1's `EnsureOwnOperator` was built with exactly this point in mind — the .proto says "it is also the
 * shape roadmap 5.11 requires, so that point inherits this surface rather than inventing a second
 * one". The rpc is idempotent, keys on the caller's validated context, and its write branch is
 * practically dead here (login already ensured the profile) — but if it ever fires it REPAIRS a
 * missing row rather than failing the read. One capability, one surface, no second rpc to drift.
 *
 * ── Why there is no permission check ─────────────────────────────────────────────────────────────
 * The subject is the caller, taken from validated claims and impossible to point at anyone else —
 * the same reasoning as `me/ui-preferences` beside it and the rpc's own controller. A permission
 * would mean an agent cannot ask who they are until an administrator grants them something, and the
 * answer is precisely what the administrator's own screens need them to have. The global AuthGuard
 * still requires a session; `@ResolvesPermissions()` is wired for the same reason the preferences
 * edge documents (the preview marker travels only when `req.effective` is populated).
 *
 * ── The isolation guarantee is the ABSENCE of a parameter ────────────────────────────────────────
 * No path segment, no query, no body. `me-operator.spec.ts` asserts the absence structurally, the
 * same way the preferences edge does — the guarantee is a property of the route table, not of a
 * comparison a later edit could weaken.
 */

interface OperatorWire {
  operatorId?: string;
  displayName?: string;
  active?: boolean;
}

interface OperatorProfileGrpc {
  ensureOwnOperator(d: Record<string, never>, md?: unknown): Observable<OperatorWire>;
}

type MeReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

@Controller()
export class MeOperatorController implements OnModuleInit {
  private profiles!: OperatorProfileGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    // The EXISTING users client — same channel the login tail already dials this service on.
    this.profiles = this.client.getService<OperatorProfileGrpc>('OperatorProfileService');
  }

  /** The caller's own operator profile. Never a 404: a missing profile is repaired, not reported. */
  @Get('me/operator')
  @ResolvesPermissions()
  async get(@Req() req: MeReq): Promise<OperatorWire> {
    const res = await callUploads(
      this.profiles.ensureOwnOperator({}, buildActorMetadata(req.claims!, req.effective)),
    );
    // The wire, restated rather than spread: a new rpc field does not silently reach the browser.
    return {
      operatorId: res.operatorId ?? '',
      displayName: res.displayName ?? '',
      active: res.active ?? false,
    };
  }
}
