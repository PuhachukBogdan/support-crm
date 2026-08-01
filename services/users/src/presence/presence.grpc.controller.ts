import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { decodeWireState, type PresenceState } from '@crm/common';
import { PresenceService, type PresenceOutcome } from './presence.service';
import { PresenceRepository } from './presence.repository';
import { LabelsRepository } from './labels.repository';

/**
 * `OperatorPresenceService` — the presence WRITES (feature 025, roadmap 5.9).
 *
 * A separate gRPC service from `UsersReadService` because a write on a service named *Read* is a lie
 * in the contract — and `tests/users-read/no-outbound.spec.ts` enforces it rather than trusting the
 * name. New service, EXISTING package, so no new hosting entry is needed; `hosting.spec.ts` asserts
 * that rather than assuming it, which is exactly what feature 015 got wrong live.
 *
 * ── Two acts that look alike and are not ────────────────────────────────────────────────────────
 *   • `SetOwnPresence` — a statement about oneself. **No permission key**, and **no audit entry**:
 *     it is history (a transition), not a sensitive action. ~58 agents toggling several times a day
 *     would otherwise bury the entries that matter, which is the same reasoning that keeps the UI
 *     preference toggle out of the audit catalogue.
 *   • `SetOperatorPresence` — overriding somebody ELSE's statement about themselves and redirecting
 *     the work they receive. Requires `users.presence.manage`, is audited, and records
 *     `cause: admin`.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const permissions = (md?: Metadata): string[] =>
  readStr(md, 'x-actor-permissions')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const STATE_WIRE: Readonly<Record<PresenceState, number>> = {
  online: 1,
  transfers_only: 2,
  away: 3,
  offline: 4,
};

const CAUSE_WIRE: Readonly<Record<string, number>> = {
  manual: 1,
  auto_inactivity: 2,
  admin: 3,
};

const STATUS_WIRE = {
  ok: 1,
  unchanged: 2,
  forbidden: 3,
  no_such_operator: 4,
  unknown_label: 5,
  name_taken: 6,
} as const;

/**
 * Decode a wire state. Returns null for anything not in the closed set — including the proto default
 * `0`. Mapping an unknown value to a default would WIDEN availability, and the widening direction is
 * the one that pushes live customers at absent agents (the fail-closed rule the REST edge already
 * applies in `services/gateway/src/chats/wire.ts`).
 */
const decodeState = decodeWireState;

interface OwnWire {
  state?: number | string;
  labelId?: string;
  label_id?: string;
}

interface OtherWire extends OwnWire {
  authUserId?: string;
  auth_user_id?: string;
}

interface ChannelWire {
  channel?: string;
  available?: boolean;
}

interface LabelWire {
  id?: string;
  name?: string;
  state?: number | string;
}

@Controller()
export class PresenceController {
  constructor(
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(PresenceRepository) private readonly repo: PresenceRepository,
    @Inject(LabelsRepository) private readonly labels: LabelsRepository,
  ) {}

  @GrpcMethod('OperatorPresenceService', 'SetOwnPresence')
  async setOwnPresence(req: OwnWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const userId = readStr(metadata, 'x-actor-user-id');
    const state = decodeState(req?.state);
    if (!accountId || !userId || !state) return this.reply({ status: 'forbidden' });

    const labelId = req?.labelId ?? req?.label_id;
    if (labelId && !(await this.labels.exists(accountId, labelId))) {
      return { status: STATUS_WIRE.unknown_label };
    }

    const outcome = await this.presence.setState(accountId, userId, state, 'manual', {
      labelId: labelId === undefined ? undefined : labelId || null,
      actorRef: userId,
      metadata,
    });
    return this.reply(outcome, accountId, userId);
  }

  @GrpcMethod('OperatorPresenceService', 'Heartbeat')
  async heartbeat(_req: unknown, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const userId = readStr(metadata, 'x-actor-user-id');
    if (!accountId || !userId) return this.reply({ status: 'forbidden' });

    const outcome = await this.presence.heartbeat(accountId, userId, new Date(), metadata);
    return this.reply(outcome, accountId, userId);
  }

  @GrpcMethod('OperatorPresenceService', 'SetChannelAvailability')
  async setChannelAvailability(req: ChannelWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const userId = readStr(metadata, 'x-actor-user-id');
    const channel = (req?.channel ?? '').trim();
    if (!accountId || !userId || !channel) return this.reply({ status: 'forbidden' });

    const outcome = await this.presence.setChannelAvailability(
      accountId,
      userId,
      channel,
      req?.available === true,
      metadata,
    );
    return this.reply(outcome, accountId, userId);
  }

  /**
   * Somebody else's presence.
   *
   * ⚠️ The permission is checked HERE as well as at the gateway. Feature 011's two-tier rule: a call
   * that skips the gateway is refused, and the service never assumes the edge did its job.
   */
  @GrpcMethod('OperatorPresenceService', 'SetOperatorPresence')
  async setOperatorPresence(req: OtherWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const actor = readStr(metadata, 'x-actor-user-id');
    const subject = req?.authUserId ?? req?.auth_user_id ?? '';
    const state = decodeState(req?.state);
    if (!accountId || !actor || !subject || !state) return this.reply({ status: 'forbidden' });

    // ⚠️ Refused under a view-as preview as well: a read-only preview that could change where a
    // colleague's work goes would not be read-only. Feature 024's group controller draws the same line.
    if (readStr(metadata, 'x-is-preview') === 'true') return this.reply({ status: 'forbidden' });

    if (!permissions(metadata).includes('users.presence.manage')) {
      return this.reply({ status: 'forbidden' });
    }

    const outcome = await this.presence.setState(accountId, subject, state, 'admin', {
      actorRef: actor,
      metadata,
    });
    return this.reply(outcome, accountId, subject);
  }

  @GrpcMethod('OperatorPresenceService', 'ListPresenceLabels')
  async listPresenceLabels(_req: unknown, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    if (!accountId) return { labels: [] };
    const rows = await this.labels.list(accountId);
    return {
      labels: rows.map((l) => ({ id: l.id, name: l.name, state: STATE_WIRE[l.state as PresenceState] })),
    };
  }

  @GrpcMethod('OperatorPresenceService', 'UpsertPresenceLabel')
  async upsertPresenceLabel(req: LabelWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const state = decodeState(req?.state);
    const name = (req?.name ?? '').trim();
    if (!accountId || !state || !name) return { status: STATUS_WIRE.forbidden };
    if (!permissions(metadata).includes('platform.settings.manage')) {
      return { status: STATUS_WIRE.forbidden };
    }

    const result = await this.labels.upsert(accountId, req?.id ?? '', name, state);
    if (result.status === 'name_taken') return { status: STATUS_WIRE.name_taken };
    if (result.status === 'unknown_label') return { status: STATUS_WIRE.unknown_label };
    return {
      status: STATUS_WIRE.ok,
      label: { id: result.label.id, name: result.label.name, state: STATE_WIRE[state] },
    };
  }

  @GrpcMethod('OperatorPresenceService', 'DeletePresenceLabel')
  async deletePresenceLabel(req: LabelWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    if (!accountId || !req?.id) return { status: STATUS_WIRE.forbidden };
    if (!permissions(metadata).includes('platform.settings.manage')) {
      return { status: STATUS_WIRE.forbidden };
    }

    // ⚠️ Deleting a decoration must never change who receives work (FR-028): the repository clears
    // the reference from anyone displaying it and leaves their STATE untouched.
    const removed = await this.labels.remove(accountId, req.id);
    return { status: removed ? STATUS_WIRE.ok : STATUS_WIRE.unknown_label };
  }

  /** One shape for every answer, so no branch can forget to report the state it left behind. */
  private async reply(outcome: PresenceOutcome, accountId?: string, authUserId?: string) {
    if (outcome.status === 'forbidden') return { status: STATUS_WIRE.forbidden };
    if (outcome.status === 'no_such_operator') return { status: STATUS_WIRE.no_such_operator };

    const blocked =
      accountId && authUserId
        ? ((await this.repo.blockedChannels(accountId, [authUserId])).get(authUserId) ?? [])
        : [];
    const operator =
      accountId && authUserId ? await this.repo.operatorFor(accountId, authUserId) : null;

    return {
      status: outcome.status === 'ok' ? STATUS_WIRE.ok : STATUS_WIRE.unchanged,
      presence: {
        authUserId: outcome.presence.auth_user_id,
        state: STATE_WIRE[outcome.presence.state as PresenceState] ?? 0,
        lastCause: outcome.presence.last_cause ? (CAUSE_WIRE[outcome.presence.last_cause] ?? 0) : 0,
        lastSeenAt: outcome.presence.last_seen_at?.toISOString() ?? '',
        labelId: outcome.presence.label_id ?? '',
        blockedChannels: blocked,
        operatorActive: operator?.active ?? false,
      },
    };
  }
}
