import { Controller, Inject, Logger, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { DomainEventPublisher } from '../events/events.publisher';
import { ANY, normaliseScope } from './policy-resolution';
import { SlaRepository, type SlaPolicyRow } from './sla.repository';
import { SlaSweepRepository } from './sla-sweep.repository';

interface SetPolicyWire {
  targetMinutes?: number;
  scopePriority?: string;
  scopeBrandId?: string;
}
interface SweepWire {
  limit?: number;
}

const toPolicyWire = (p: SlaPolicyRow) => ({
  id: p.id,
  targetMinutes: p.target_minutes,
  scopePriority: p.scope_priority,
  scopeBrandId: p.scope_brand_id,
});

/** Default batch when a caller does not say (the worker always does). */
const DEFAULT_SWEEP_LIMIT = 500;

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * First-reply SLA policy management (feature 014, US2 — roadmap 4.7), gated by `crm.sla.manage` at
 * both tiers.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class SlaController {
  constructor(@Inject(SlaRepository) private readonly sla: SlaRepository) {}

  @GrpcMethod('ChatsReadService', 'GetFirstReplySlaPolicies')
  @RequiresChatsPermission('crm.sla.manage')
  async getFirstReplySlaPolicies(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const policies = await this.sla.listPolicies(ctx.accountId);
    return { policies: policies.map(toPolicyWire) };
  }

  @GrpcMethod('ChatsWriteService', 'SetFirstReplySlaPolicy')
  @RequiresChatsPermission('crm.sla.manage')
  async setFirstReplySlaPolicy(req: SetPolicyWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const target = Math.trunc(Number(req?.targetMinutes ?? 0));
    if (!Number.isFinite(target) || target <= 0) {
      // A zero/negative target would mean "breach immediately, forever" — refuse rather than store it.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'target_minutes must be a positive number of minutes',
      });
    }
    const scopePriority = normaliseScope(req?.scopePriority);
    const scopeBrandId = normaliseScope(req?.scopeBrandId);
    // `'*'` is the "any" sentinel; accepting it as a literal priority/brand would make the scope
    // ambiguous (research R7). Empty already normalises to the sentinel above, so an explicit '*' can
    // only arrive from a caller trying to use it as a real value.
    if ((req?.scopePriority ?? '').trim() === ANY || (req?.scopeBrandId ?? '').trim() === ANY) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: "'*' is reserved — omit the scope to mean any",
      });
    }
    const row = await this.sla.setPolicy(ctx.accountId, {
      targetMinutes: target,
      scopePriority,
      scopeBrandId,
    });
    return toPolicyWire(row);
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The maintenance surface — a SEPARATE gRPC service, deliberately (feature 014, research R2/R3).
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Entry point for the worker's repeatable tick. It is not a user-facing surface:
 *   • the gateway exposes NO route to it (asserted by `gateway/src/chats/no-maintenance-route.spec.ts`);
 *   • the handler requires `x-actor-kind: system` and refuses a normal user actor;
 *   • it answers with COUNTS — never rows — so no tenant data crosses the boundary even to a system
 *     caller.
 *
 * It is also the only caller of the single unscoped id-only read (`SlaSweepRepository`). Everything it
 * then does runs through `forAccount(accountId)`: the unscoped step chooses *which* accounts have
 * work; the scoped path does the work.
 *
 * There is no `@UseGuards(ChatsAccessGuard)` here on purpose — that guard reads a user's permission
 * metadata, and this caller is not a user. The system-actor check below is its gate.
 */
@Controller()
export class SlaMaintenanceController {
  private readonly logger = new Logger(SlaMaintenanceController.name);

  constructor(
    @Inject(SlaRepository) private readonly sla: SlaRepository,
    @Inject(SlaSweepRepository) private readonly sweep: SlaSweepRepository,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
  ) {}

  @GrpcMethod('ChatsMaintenanceService', 'SweepFirstReplySla')
  async sweepFirstReplySla(req: SweepWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      // A user session must never reach a cross-account path, even a counts-only one.
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const now = new Date();
    const limit = Math.trunc(Number(req?.limit ?? 0)) || DEFAULT_SWEEP_LIMIT;
    const due = await this.sweep.findDueConversationIds(limit, now);

    let breached = 0;
    let rulesApplied = 0;
    for (const row of due) {
      // Per account, through the SCOPED client. `markBreached` is the announce-once transition: only
      // the call that actually flipped the row goes on to emit, so a second tick emits nothing.
      const marked = await this.sla.markBreached(row.account_id, row.conversation_id, now);
      if (!marked) continue;
      breached += 1;
      try {
        rulesApplied += await this.events.firstReplyBreached(row.account_id, row.conversation_id);
      } catch (err) {
        // A rule blowing up must not stop the sweep: the breach is already recorded and listable,
        // which is the part the measurement guarantees regardless of any rule (US3 acceptance #2).
        this.logger.warn(
          `breach rules failed for conversation ${row.conversation_id}: ${
            err instanceof Error ? err.name : 'error'
          }`,
        );
      }
    }
    // COUNTS ONLY — no ids of any kind cross this boundary.
    return { checked: due.length, breached, rulesApplied };
  }
}
