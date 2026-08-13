import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Metadata, type MetadataValue } from '@grpc/grpc-js';
import { HandoverRepository, type OpenWorkRow } from './handover.repository';
import { ChannelRepository } from '../channel/channel.repository';
import { StatusRepository } from '../status/status.repository';
import { AuditRepository } from '../audit/audit.repository';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { systemActor } from '../transition/conversation-transitions';

/**
 * `ReturnOperatorWorkToBacklog` — the offboarding handover (W31 / feature 038, ADR 0043 §4, SEC-PV2).
 *
 * ── What this exists to prevent ─────────────────────────────────────────────────────────────────
 * Deactivating an account is the failure that looks like nothing: the person vanishes from every
 * routing pool (users stops returning inactive operators), their conversations stay assigned to them,
 * and the customer writes to nobody. No error, no alert — which is why ADR 0043 §4 makes deactivation
 * a HANDOVER rather than a flag, and why this rpc reports COUNTS a human can act on.
 *
 * ── Every property of the maintenance service it lives on ───────────────────────────────────────
 * System actor only, no gateway route, counts in the answer. The gate is the actor KIND, which no
 * breadth of permission satisfies: an ordinary session must never be able to sweep a colleague's
 * whole workload off them, and the caller here is the provisioning path, which belongs to no person
 * (research D5 — the gateway orchestrates auth's deactivation and this call, because neither auth nor
 * users holds a chats client and there is no bus).
 *
 * ── ⚠️ NO DESK ⇒ NOTHING IS TOUCHED ─────────────────────────────────────────────────────────────
 * A conversation whose destination cannot be resolved keeps its owner and is counted in `no_desk`.
 * Unassigning it would produce «nobody's and unqueued» — precisely the state this rpc exists to
 * prevent — and a count an administrator can read beats a silent skip that leaves nothing to read.
 *
 * ── Idempotent, and re-runnable on purpose ──────────────────────────────────────────────────────
 * Research D5 accepts that the handover can fail after the account is already closed, and answers it
 * with «re-issue the same call»: every write asserts the departed operator in its predicate, so a
 * second run over already-moved work matches nothing and reports `moved: 0`.
 */
@Controller()
export class HandoverMaintenanceController {
  constructor(
    @Inject(HandoverRepository) private readonly handover: HandoverRepository,
    // The account's own non-terminal vocabulary. Feature 032's rule: nothing branches on a status
    // WORD, so «still open» is a question for the catalogue, never a hard-coded pair of keys.
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
    // The fallback destination: a channel names the desk its tickets are pushed to (W5, subpoint 2.4).
    @Inject(ChannelRepository) private readonly channels: ChannelRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    // The moved work has to appear in the queue's readers by itself — the same publish the drain does.
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
  ) {}

  @GrpcMethod('ChatsMaintenanceService', 'ReturnOperatorWorkToBacklog')
  async returnOperatorWorkToBacklog(
    req: { accountId?: string; operatorId?: string; limit?: number },
    metadata: Metadata,
  ) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }

    /**
     * ⚠️ **The account is in the REQUEST and is refused when absent**, like `ResolveRoutingOperators`
     * one service over: a machine has no account of its own, and defaulting one is a cross-account
     * write waiting to happen — here a write that would empty somebody's queue in the wrong tenant.
     */
    const accountId = String(req?.accountId ?? '').trim();
    const operatorId = String(req?.operatorId ?? '').trim();
    if (!accountId || !operatorId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'account_id and operator_id are required',
      });
    }

    // Server-capped, like every other maintenance batch: a caller cannot ask for the whole account.
    const limit = Math.min(Math.max(Number(req?.limit ?? 0) || 50, 1), 100);

    /**
     * ⚠️ An account with NO non-terminal status is misconfigured, and this refuses loudly rather than
     * reporting `moved: 0`. An empty `in` predicate matches nothing, so the silent version would say
     * «this person held no open work» about somebody holding all of it — the SEC-PV2 shape exactly,
     * produced by our own query. The status catalogue's own rule: null is a real answer and the
     * caller's job is to fail on it.
     */
    const statusKeys = await this.statuses.nonTerminalKeys(accountId);
    if (statusKeys.length === 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'account has no non-terminal statuses configured',
      });
    }

    const [total, skippedShelved, rows] = await Promise.all([
      this.handover.countOpenWorkOf(accountId, operatorId, statusKeys),
      this.handover.countShelvedWorkOf(accountId, operatorId, statusKeys),
      this.handover.openWorkOf(accountId, operatorId, statusKeys, limit),
    ]);

    const deskOfChannel = await this.channelDesks(accountId);
    // ONE act, so ONE actor and ONE correlation id: every transition this call writes points at the
    // same audit entry, which is what makes «what moved, and why» answerable from either end.
    const actor = systemActor('staff-handover');
    const at = new Date();

    let moved = 0;
    let noDesk = 0;
    const movedIds: string[] = [];

    for (const row of rows) {
      const desk = row.routed_group_id ?? deskOfChannel(row);
      if (!desk) {
        noDesk += 1;
        continue;
      }
      const done = await this.handover.returnToBacklog(
        accountId,
        row.id,
        operatorId,
        desk,
        at,
        actor,
      );
      if (!done) {
        // It stopped being this operator's between the read and the write — a human reassigned it, or
        // an earlier run already moved it. Counted as neither: the invariant («nothing is left with
        // the departed person») holds, and claiming a move we did not make would inflate the report.
        continue;
      }
      moved += 1;
      movedIds.push(row.id);
    }

    // After the commits, best-effort by the publisher's own contract (it never throws).
    for (const id of movedIds) {
      await this.realtime.conversation('conversation.updated', accountId, id);
    }

    /**
     * ⭐ ONE entry for the whole handover (FR-018), and only when it did something.
     *
     * A run that moved nothing changed nothing, and this rpc is idempotent and re-runnable by design
     * (research D5) — auditing every retry would fill the staffing trail with zeros and bury the one
     * line that matters. The act itself is already on the record as `provisioning.deactivate`, written
     * by auth; this entry answers the separate question that deactivation cannot: did the WORK move.
     *
     * Counts only. A conversation id here would put customer work into a trail read for staffing
     * reasons (Principle IV), and the detail allow-list refuses anything else anyway.
     */
    if (moved > 0 || noDesk > 0) {
      await this.audit.append(accountId, {
        action: 'staff.handover',
        actorUserId: '',
        actorKind: 'system',
        actorRef: 'staff-handover',
        targetRef: operatorId,
        detail: { movedCount: moved, noDeskCount: noDesk },
      });
    }

    return {
      moved,
      noDesk,
      skippedShelved,
      // What this call did not look at. The no-desk rows are still assigned too, and are reported on
      // their own line — a caller looping on `remaining` alone would otherwise loop for ever.
      remaining: Math.max(0, total - rows.length),
    };
  }

  /**
   * The desk a conversation falls back to when it was never routed to one: the default desk of the
   * channel it arrived on, which is unique per `(brand, kind)` by the `Channel` model's own
   * constraint. Read ONCE per call — an account has a handful of channels, and a lookup per
   * conversation would be a query per row on a path somebody is waiting for.
   *
   * A conversation with no arrival channel (an agent raised it) or a channel that names no desk
   * resolves to nothing — an honest absence, answered as `no_desk`, never an invented destination
   * (the `Group.routable` reasoning: a deployment that has not decided must stay quiet).
   */
  private async channelDesks(accountId: string): Promise<(row: OpenWorkRow) => string | null> {
    const channels = await this.channels.listForAccount(accountId);
    const byBrandAndKind = new Map<string, string>();
    for (const ch of channels) {
      if (ch.default_group_id) byBrandAndKind.set(`${ch.brand_id} ${ch.kind}`, ch.default_group_id);
    }
    return (row) =>
      row.channel ? (byBrandAndKind.get(`${row.brand_id} ${row.channel}`) ?? null) : null;
  }
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}
