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

/**
 * Feature 033: counts from one outbound pass.
 *
 * ⚠️ `failed` climbing with `sent` at zero is the signal that matters here, and it is the only signal
 * this boundary carries: the recipient, the subject and the body are all customer content and none of
 * them crosses (research R6, FR-044).
 */
export interface SendDueCounts {
  attempted: number;
  sent: number;
  failed: number;
}

/** Feature 031: counts only. `skipped` high with `assigned` zero is the head-of-line signal. */
interface DrainResult {
  considered: number;
  assigned: number;
  skipped: number;
  unroutable: number;
}

/** Feature 033: which tenant owns a channel key. Empty account = unknown or disabled (FR-008). */
export interface IntakeChannel {
  accountId: string;
  brandId: string;
  kind: string;
}

/** Feature 033: one message out of a mailbox, already normalised. See `channels/email.adapter.ts`. */
export interface InboundEmail {
  channelKey: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  fromAddress: string;
  subject: string;
  bodyText: string;
  uploadIds: string[];
  sentAt?: number;
}

/** Feature 033: what chats did with it. `duplicate` is a SUCCESS — a reconnect redelivers by design. */
export interface IntakeOutcome {
  conversationId: string;
  duplicate: boolean;
  refusalClass: string;
}

interface WriteGrpc {
  acceptInboundEmail(data: InboundEmail, md?: Metadata): Observable<Record<string, unknown>>;
}

interface MaintenanceGrpc {
  sweepFirstReplySla(data: { limit: number }, md?: Metadata): Observable<SweepResult>;
  // Feature 033: asked once per channel key and held — the mailbox↔channel binding is configuration.
  resolveIntakeChannel(
    data: { channelKey: string },
    md?: Metadata,
  ): Observable<Partial<IntakeChannel>>;
  // Feature 017 (roadmap 4.10): the export queue tick and the record-expiry tick. Same shape as the
  // sweep above — a limit in, counts out.
  runDueExports(data: { limit: number }, md?: Metadata): Observable<RunDueExportsResult>;
  expireDueExports(data: { limit: number }, md?: Metadata): Observable<ExpireDueExportsResult>;
  // Feature 023: health only. There is deliberately no list/read counterpart to call.
  reportTransitionStreamHealth(data: { limit: number }, md?: Metadata): Observable<TransitionStreamHealth>;
  // Feature 023 (roadmap 4.18): close the title windows whose ten minutes have passed.
  sweepConversationSubjects(data: { limit: number }, md?: Metadata): Observable<SweepSubjectsResult>;
  // ⭐ Feature 031 (roadmap 4.20): drain the backlog as capacity frees. Same shape — a limit in, counts out.
  drainBacklog(data: { limit: number }, md?: Metadata): Observable<DrainResult>;
  // ⭐ Feature 033 (roadmap 6.5): claim and send due conversation replies. Counts out — never a recipient.
  sendDueChannelMessages(data: { limit: number }, md?: Metadata): Observable<SendDueCounts>;
}

@Injectable()
export class ChatsMaintenanceClient implements OnModuleInit {
  private svc!: MaintenanceGrpc;
  private write!: WriteGrpc;

  constructor(@Inject(WORKER_CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<MaintenanceGrpc>('ChatsMaintenanceService');
    // ⚠️ Feature 033: the FIRST time this client reaches a write service rather than a maintenance one,
    // and the exception is stated rather than quietly taken. Taking mail in IS a write — there is no
    // counts-only shape for "here is a customer's message" — and the alternative was a maintenance rpc
    // that writes, which would make this client's own rule ("scheduling only") false while looking true.
    this.write = this.client.getService<WriteGrpc>('ChatsWriteService');
  }

  /**
   * Which tenant owns a channel key (feature 033).
   *
   * ⚠️ An empty `accountId` is an ANSWER, not a failure: the key is unknown or the operator disabled the
   * channel, and those are deliberately indistinguishable (FR-008). The reader stays shut on it.
   *
   * A transport failure THROWS — the caller must not read "cannot ask" as "not configured", or a downed
   * chats would silently turn the mailbox off and the mail would pile up unread with nothing red anywhere.
   */
  async resolveIntakeChannel(channelKey: string): Promise<IntakeChannel> {
    const res = await firstValueFrom(
      this.svc.resolveIntakeChannel({ channelKey }, systemMetadata()),
    );
    return {
      accountId: String(res?.accountId ?? ''),
      brandId: String(res?.brandId ?? ''),
      kind: String(res?.kind ?? ''),
    };
  }

  /**
   * Hand one mailbox message to chats (feature 033, roadmap 6.4).
   *
   * ⚠️ **Nothing about the message is logged by this client**, and the parameter object is never spread
   * into an error: `fromAddress`, `subject` and `bodyText` are all customer content (FR-047).
   *
   * Chats decides everything else — the thread, the identity, the status, at-most-once. This is a
   * transport, and keeping it one is what stops two intake paths from growing two sets of rules.
   */
  async acceptInboundEmail(message: InboundEmail): Promise<IntakeOutcome> {
    const res = await firstValueFrom(this.write.acceptInboundEmail(message, systemMetadata()));
    return {
      conversationId: String(res?.conversationId ?? ''),
      duplicate: res?.duplicate === true,
      refusalClass: String(res?.refusalClass ?? ''),
    };
  }

  /** Run one sweep. Returns counts only — no tenant data crosses this boundary (research R3). */
  async sweepFirstReplySla(limit: number): Promise<SweepResult> {
    return firstValueFrom(this.svc.sweepFirstReplySla({ limit }, systemMetadata()));
  }

  /**
   * Drain the backlog (feature 031, roadmap 4.20). Counts only.
   *
   * ⚠️ It must be reached from a job at all, or `tests/worker/maintenance-ticks.spec.ts` fails the build —
   * declaring a maintenance rpc and never ticking it is the defect feature 017 shipped, and this guard is
   * what caught it here before the queue could quietly never drain.
   */
  async drainBacklog(limit: number): Promise<DrainResult> {
    return firstValueFrom(this.svc.drainBacklog({ limit }, systemMetadata()));
  }

  /**
   * Send due conversation replies (feature 033, roadmap 6.5). Counts only.
   *
   * ⚠️ The worker's whole role is saying "now". It holds no outbox, fetches no envelope, opens no
   * connection and never sees a message — chats owns all four. That split is why this method takes a
   * limit and returns three numbers.
   */
  async sendDueChannelMessages(limit: number): Promise<SendDueCounts> {
    return firstValueFrom(this.svc.sendDueChannelMessages({ limit }, systemMetadata()));
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
