import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { MaintenanceService } from './maintenance.service';
import { PresenceSweepService } from '../presence/presence-sweep.service';
import { OperatorRepository } from '../operator/operator.repository';
import { ChannelParticipantService } from '../channel/channel-participant.service';
import type { PresenceState } from '@crm/common';
import { loadUsersConfig } from '../config';

interface BatchWire {
  limit?: number;
}

interface ResolveRoutingWire {
  accountId?: string;
  authUserIds?: string[];
}

interface ResolveParticipantWire {
  accountId?: string;
  brandId?: string;
  channelKind?: string;
  kind?: string;
  value?: string;
}

/**
 * The wire numbering, local to this file for the reason `player.grpc.controller.ts` states about its own
 * copy: the numbering belongs to the CONTRACT, and each surface that encodes it owns its encoder. A
 * shared one would be a third place to change when the proto changes.
 */
const PRESENCE_STATE_WIRE: Readonly<Record<PresenceState, number>> = {
  online: 1,
  transfers_only: 2,
  away: 3,
  offline: 4,
};

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * `UsersMaintenanceService` — the only way to reach the one byte-removing path (feature 017, US3).
 *
 * Three properties, and all three are needed for the narrowing of feature 016's "nothing removes bytes"
 * to be a narrowing rather than a hole:
 *
 *   • **System actor only.** A user session must never reach a cross-account path, even a counts-only
 *     one — feature 014's rule for the SLA sweep, applied to something with teeth.
 *   • **No gateway route.** `tests/exports/no-presign.spec.ts` and the route scan assert that nothing in
 *     the gateway maps to a maintenance RPC, so "system actor only" cannot be reached by asking nicely
 *     over HTTP.
 *   • **Counts only in the response.** The caller is a scheduler; ids and keys would be data it has no
 *     use for and a log line waiting to happen.
 *
 * It is a SEPARATE gRPC service from `UploadsService`, deliberately. Putting a purge verb on the
 * requester-facing surface is how "there is no DeleteUpload" quietly stops being true.
 *
 * ⚠️ The handler carries no permission decorator and that is not an omission: there is no permission
 * that grants deletion, because no ROLE may reach this at all. The check is the actor KIND, which no
 * amount of permission breadth satisfies — the same reasoning that keeps the audit trail append-only
 * for the owner.
 */
@Controller()
export class MaintenanceController {
  constructor(
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    // Feature 025 (roadmap 5.9): the auto-away sweep. Same three properties as the purge above —
    // system actor only, no gateway route, counts in the response — which is why it lives here and
    // not on the presence service.
    @Inject(PresenceSweepService) private readonly sweep: PresenceSweepService,
    // Feature 031: the same repository the human-facing rpc uses. ONE method answers "who can take
    // this work?" — two surfaces ask it, with two different gates.
    @Inject(OperatorRepository) private readonly operators: OperatorRepository,
    // ⭐ Feature 033 (roadmap 6.4): the reply envelope. Here for the same three properties — system
    // actor only, no gateway route, and a caller that is a machine with no credentials to forward.
    @Inject(ChannelParticipantService) private readonly participants: ChannelParticipantService,
  ) {}

  @GrpcMethod('UsersMaintenanceService', 'PurgeExpiredArtefacts')
  async purgeExpiredArtefacts(req: BatchWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    // The service clamps the batch; passing the raw value through keeps the ceiling in one place.
    const counts = await this.maintenance.purgeExpiredArtefacts(Number(req?.limit ?? 0), new Date());
    return {
      purged: counts.purged,
      objectMissing: counts.objectMissing,
      failed: counts.failed,
    };
  }

  /**
   * Lower the availability of operators whose session has gone quiet (feature 025, roadmap 5.9).
   *
   * Here rather than on `OperatorPresenceService`, and for the three properties that make this
   * service what it is. The middle one is the security argument: a sweep reachable from a session
   * would be a way to put a colleague offline without holding `users.presence.manage`, which is the
   * key that governs exactly that.
   */
  @GrpcMethod('UsersMaintenanceService', 'SweepIdlePresence')
  async sweepIdlePresence(req: BatchWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const cfg = loadUsersConfig();
    const counts = await this.sweep.sweepIdle(Number(req?.limit ?? 0), new Date(), {
      awayAfterSeconds: cfg.PRESENCE_AWAY_AFTER_SECONDS,
      offlineAfterSeconds: cfg.PRESENCE_OFFLINE_AFTER_SECONDS,
    });
    return { toAway: counts.toAway, toOffline: counts.toOffline, failed: counts.failed };
  }

  /**
   * ⭐ Who at a desk can take pushed work — asked by a MACHINE (feature 031, roadmap 4.20).
   *
   * ── Why this exists beside an rpc that already answers it ──────────────────────────────────────
   * `UsersReadService.ListOperatorsByAuthUsers` answers the same question, gated on
   * `crm.conversation.assign`, and its comment states the rule this handler obeys: *"the caller forwards
   * its own credentials unchanged; calling as a system actor would launder the permission."*
   *
   * The backlog drain has no credentials to forward — a periodic tick belongs to no person. Relaxing the
   * human rpc to accept a system actor would have made that sentence false for every caller. So the
   * machine gets its own surface with the gate this service exists for: the actor **kind**, which no
   * breadth of permission satisfies.
   *
   * ⚠️ **The account is in the REQUEST**, and refused when absent. A system caller has no account of
   * its own; the drain takes it from the row it is acting on. Defaulting it to anything would be a
   * cross-account read waiting to happen.
   *
   * ⓘ Staffing facts only — operator id, auth id, presence state, switched-off channels. There is no
   * customer data in this answer to mask and nothing here to audit as an access (the same judgement the
   * human rpc records).
   */
  @GrpcMethod('UsersMaintenanceService', 'ResolveRoutingOperators')
  async resolveRoutingOperators(req: ResolveRoutingWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const accountId = String(req?.accountId ?? '').trim();
    if (!accountId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'account_id is required' });
    }
    const asked = Array.isArray(req?.authUserIds) ? req.authUserIds.map((id) => String(id ?? '')) : [];
    const resolved = await this.operators.resolveByAuthUserIds(accountId, asked);
    return {
      operators: resolved.map((r) => ({
        operatorId: r.operatorId,
        authUserId: r.authUserId,
        state: PRESENCE_STATE_WIRE[r.state] ?? 4,
        blockedChannels: r.blockedChannels,
      })),
    };
  }

  /**
   * ⭐ Where to answer, and who wrote — one call (feature 033, roadmap 6.4).
   *
   * ── ⚠️ THE REQUEST CARRIES A CUSTOMER'S CONTACT VALUE, AND NOTHING HERE MAY LOG IT ─────────────
   * `value` is an email address in clear. It crosses one in-cluster hop because this service owns
   * contact values, the hash salt and the masking regime — sending the value to its owner is strictly
   * better than copying `CONTACT_HASH_SALT` into chats so chats could hash locally (research R10).
   *
   * The consequence is a rule, not a preference: **this handler logs nothing about its request**, and
   * `services/users/src/channel/channel-participant.spec.ts` asserts it — on the accepted path and on the
   * refused ones. An error message must not quote the request either, which is why the refusals below name
   * the missing FIELD and never its content.
   *
   * ── Why one rpc does two jobs ──────────────────────────────────────────────────────────────────
   * Intake performs both at the same moment for the same message. Two calls would allow the envelope to
   * be recorded for a thread whose identity lookup failed, or the reverse — and either leaves a ticket
   * whose two halves disagree about the same customer.
   */
  @GrpcMethod('UsersMaintenanceService', 'ResolveChannelParticipant')
  async resolveChannelParticipant(req: ResolveParticipantWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const accountId = String(req?.accountId ?? '').trim();
    const brandId = String(req?.brandId ?? '').trim();
    if (!accountId || !brandId) {
      // ⚠️ Both refused rather than defaulted. Identity is brand-scoped (ADR 0038): the same address
      // under two brands is two people until a `Person` link says otherwise, so a missing brand is not
      // "any brand" — it is a cross-brand attachment waiting to happen.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'account_id and brand_id are required',
      });
    }
    const value = String(req?.value ?? '').trim();
    if (!value) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'value is required' });
    }

    /**
     * ⚠️ **Two different `kind`s, and confusing them is how a phone gets matched against email hashes.**
     *
     *  · `channelKind` (`api | email | messenger`) keys the envelope ROW — which channel this address
     *    belongs to.
     *  · `kind` is the identifier CLASS (`email | phone | player_id`) — it decides HOW the value is
     *    resolved: a hash lookup against `ContactMatch`, or an existence check against `Player`.
     *
     * An unrecognised class is REFUSED rather than defaulted. Defaulting to `email` would hash a platform
     * id as if it were an address and match it against nothing for ever, which reads as "identity never
     * works" with nothing pointing at the cause.
     */
    const identifierKind = String(req?.kind ?? '').trim() || 'email';
    if (identifierKind !== 'email' && identifierKind !== 'phone' && identifierKind !== 'player_id') {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'kind must be email, phone or player_id',
      });
    }

    return this.participants.register({
      accountId,
      brandId,
      kind: String(req?.channelKind ?? '').trim() || 'email',
      address: value,
      identifierKind,
    });
  }
}
