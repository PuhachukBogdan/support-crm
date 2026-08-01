import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { CHATS_PACKAGE, CHATS_PROTO, grpcClientOptions } from '@crm/common';

/**
 * worker → chats maintenance client (feature 014, roadmap 4.7 / research R2).
 *
 * The worker's whole role in the SLA is **scheduling**: fire a tick, ask chats to sweep. It holds no
 * rule state, reads no database (it has none) and makes no decisions about what counts as a breach —
 * chats owns the data and the verdict. That split is why this client has exactly one method.
 *
 * `x-actor-kind: system` marks the caller as not-a-user. The maintenance RPC refuses anything else, and
 * the gateway exposes no route to it, so this is the only way in.
 */
export const WORKER_CHATS_CLIENT = 'WORKER_CHATS_CLIENT';

export interface SweepResult {
  checked: number;
  breached: number;
  rulesApplied: number;
}

/** Feature 017: counts from one export pass. No ids, no scopes, no filter values. */
export interface RunDueExportsResult {
  claimed: number;
  completed: number;
  failed: number;
  recoveredStale: number;
}
export interface ExpireDueExportsResult {
  expired: number;
}

/**
 * Feature 023 (roadmap 4.8a): is the transition stream alive? Counts and one timestamp — never a row.
 * int64 arrives as a STRING (proto-loader longs:String), so the numbers are parsed here rather than
 * trusted as numbers (the grpc-wire-encoding gotcha).
 */
export interface TransitionStreamHealth {
  total: string;
  lastHour: string;
  newestAt: string;
}

/** Feature 023 (roadmap 4.18): how many title windows the tick found overdue, and how many it closed. */
export interface SweepSubjectsResult {
  checked: number;
  closed: number;
}

interface MaintenanceGrpc {
  sweepFirstReplySla(data: { limit: number }, md?: Metadata): Observable<SweepResult>;
  // Feature 017 (roadmap 4.10): the export queue tick and the record-expiry tick. Same shape as the
  // sweep above — a limit in, counts out.
  runDueExports(data: { limit: number }, md?: Metadata): Observable<RunDueExportsResult>;
  expireDueExports(data: { limit: number }, md?: Metadata): Observable<ExpireDueExportsResult>;
  // Feature 023: health only. There is deliberately no list/read counterpart to call.
  reportTransitionStreamHealth(data: { limit: number }, md?: Metadata): Observable<TransitionStreamHealth>;
  // Feature 023 (roadmap 4.18): close the title windows whose ten minutes have passed.
  sweepConversationSubjects(data: { limit: number }, md?: Metadata): Observable<SweepSubjectsResult>;
}

@Injectable()
export class ChatsMaintenanceClient implements OnModuleInit {
  private svc!: MaintenanceGrpc;

  constructor(@Inject(WORKER_CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<MaintenanceGrpc>('ChatsMaintenanceService');
  }

  /** Run one sweep. Returns counts only — no tenant data crosses this boundary (research R3). */
  async sweepFirstReplySla(limit: number): Promise<SweepResult> {
    return firstValueFrom(this.svc.sweepFirstReplySla({ limit }, systemMetadata()));
  }

  /** Claim and run due exports; also recover stale claims (feature 017). Counts only. */
  async runDueExports(limit: number): Promise<RunDueExportsResult> {
    return firstValueFrom(this.svc.runDueExports({ limit }, systemMetadata()));
  }

  /** Flip `ready` exports past their expiry to `expired` (feature 017). Counts only. */
  async expireDueExports(limit: number): Promise<ExpireDueExportsResult> {
    return firstValueFrom(this.svc.expireDueExports({ limit }, systemMetadata()));
  }

  /**
   * Feature 023: ask whether the transition stream is being written. The only call in this client that
   * asks a question instead of doing work — and it exists because the stream has no consumer yet, so
   * without it nothing in the product could notice it had stopped.
   */
  async reportTransitionStreamHealth(): Promise<TransitionStreamHealth> {
    return firstValueFrom(
      // `limit` is unused by this rpc; the shared SweepRequest shape carries it.
      this.svc.reportTransitionStreamHealth({ limit: 0 }, systemMetadata()),
    );
  }

  /**
   * Feature 023: close the title windows whose ten minutes have passed (roadmap 4.18, FR-018).
   *
   * The other two arms of the window close on the write path itself; only the timeout needs a tick.
   * Counts only — no conversation id and certainly no title crosses this boundary.
   */
  async sweepConversationSubjects(limit: number): Promise<SweepSubjectsResult> {
    return firstValueFrom(this.svc.sweepConversationSubjects({ limit }, systemMetadata()));
  }
}

/** `x-actor-kind: system` — the maintenance RPCs refuse any other caller, and no gateway route exists. */
function systemMetadata(): Metadata {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  return md;
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: WORKER_CHATS_CLIENT,
        useFactory: () =>
          grpcClientOptions(CHATS_PACKAGE, CHATS_PROTO, process.env.CHATS_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [ChatsMaintenanceClient],
  exports: [ChatsMaintenanceClient],
})
export class WorkerChatsModule {}
