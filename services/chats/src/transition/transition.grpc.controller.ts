import { Controller, Inject, Logger } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { TransitionHealthRepository } from './transition.repository';
import { SubjectSweepRepository } from '../subject/subject.sweep';
import { TransitionRecorder } from './transition.recorder';
import { systemActor } from './conversation-transitions';

/** Matches the SLA sweep's default; both are server-capped inside the repository. */
const DEFAULT_SUBJECT_SWEEP_LIMIT = 200;

/**
 * The transition stream's ONLY read surface (feature 023, roadmap 4.8a — FR-012).
 *
 * ── Why a stream with no consumer still needs one call ───────────────────────────────────────────
 * The aggregation store is roadmap 11.0. Until it exists nothing reads a transition, so nothing would
 * notice if the stream silently stopped being written. This project has shipped exactly that twice:
 * a hosted gRPC package whose handler was never registered (015) and a maintenance rpc reached by no
 * tick (017) — both found only on Track B, both invisible to a unit test.
 *
 * ── What it deliberately is NOT ──────────────────────────────────────────────────────────────────
 * It is not a list, a page or a query. **Counts and one timestamp.** Returning rows would be the read
 * surface this feature refuses to build, and once one exists somebody will filter it, then page it,
 * then render it — and the "no consumer yet" decision would have been made by accident.
 *
 * Fenced exactly as `SweepFirstReplySla` is: `x-actor-kind: system` required, and the gateway exposes
 * no route to `ChatsMaintenanceService` at all (asserted by a gateway spec).
 */
function readMeta(md: Metadata | undefined, key: string): string {
  const v = md?.get(key)?.[0];
  return typeof v === 'string' ? v : '';
}

@Controller()
export class TransitionMaintenanceController {
  private readonly logger = new Logger(TransitionMaintenanceController.name);

  constructor(
    @Inject(TransitionHealthRepository) private readonly health: TransitionHealthRepository,
    @Inject(SubjectSweepRepository) private readonly subjects: SubjectSweepRepository,
    @Inject(TransitionRecorder) private readonly recorder: TransitionRecorder,
  ) {}

  @GrpcMethod('ChatsMaintenanceService', 'ReportTransitionStreamHealth')
  async reportTransitionStreamHealth(_req: unknown, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      // A user session must never reach a cross-account path, even a counts-only one.
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }

    const report = await this.health.report(new Date());

    // int64 crosses the wire as a STRING (proto-loader `longs:String`) — the grpc-wire-encoding
    // gotcha. Counts only; `newestAt` is a timestamp, which carries no tenant data.
    return {
      total: String(report.total),
      lastHour: String(report.lastHour),
      newestAt: report.newestAt ? report.newestAt.toISOString() : '',
    };
  }

  /**
   * Close the title windows whose ten minutes have passed (roadmap 4.18, FR-018 / T031).
   *
   * It lives on this controller rather than its own because the fencing is identical and duplicating
   * the `x-actor-kind` check is how one copy of it eventually differs.
   *
   * The actor is `system:subject-sweep` and not a bare "system": an automated writer that named a
   * conversation must be nameable in the stream, or "who set this title" answers *the machine* for
   * every automatic subject and the transition stops being able to distinguish its own writers.
   */
  @GrpcMethod('ChatsMaintenanceService', 'SweepConversationSubjects')
  async sweepConversationSubjects(req: { limit?: number }, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }

    const now = new Date();
    const limit = Math.trunc(Number(req?.limit ?? 0)) || DEFAULT_SUBJECT_SWEEP_LIMIT;
    const due = await this.subjects.findExpiredWindows(limit, now);

    // One correlation id for the tick, so every window it closed is attributable to one run.
    const actor = systemActor('subject-sweep');

    let closed = 0;
    for (const row of due) {
      try {
        if (await this.subjects.closeWindow(row.account_id, row.id, this.recorder, actor, now)) {
          closed += 1;
        }
      } catch (err) {
        // One conversation failing must not stop the tick — the rest are still overdue, and the next
        // tick retries this one because its window is still open. Reason CLASS only, never a title.
        this.logger.warn(
          `subject window close failed: ${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }

    // COUNTS ONLY — no ids of any kind cross this boundary.
    return { checked: due.length, closed };
  }
}
