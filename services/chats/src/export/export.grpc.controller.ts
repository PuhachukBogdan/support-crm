import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import {
  readActorContext,
  readActorPermissions,
  resolveBrandIn,
} from '../security/actor-context';
import { hasPermission } from '@crm/common';
import { isShelfState } from '../conversation/shelf';
import { ChatsAccessGuard } from '../security/permission.guard';
import { wireToSlaOutcome } from '../shared/wire';
import { StatusRepository } from '../status/status.repository';
import { resolveStatusFilter, StatusFilterError } from '../status/status-filter';
// ⭐ W24: the ONE cleaning of the search operand — the export must interpret `[1043]` exactly the
// way the list does, or the same request exports a different set than it showed (SEC-AP2).
import { cleanSearch } from '../conversation/conversation.grpc.controller';
import { QuotaExhaustedError } from './export.quota';
import { ExportMaintenance } from './export.maintenance';
import {
  ExportForbiddenError,
  ExportService,
  UnknownScopeError,
} from './export.service';
import { ExportRepository, type ExportJobRow } from './export.repository';

interface CreateWire {
  scope?: string;
  filters?: {
    /** ⚠️ Feature 032: the DEPRECATED enum filter — refused, never mapped (see `status-filter.ts`). */
    status?: string;
    statusKey?: string;
    statusCategory?: string;
    priority?: string;
    assigneeOperatorId?: string;
    playerId?: string;
    brandId?: string;
    slaOutcome?: string;
    /** Feature 029: mirrors the list's channel filter — see `ExportFilters` in chats.proto. */
    channel?: string;
    /** W5: mirrors the list's plural category filter; the shared resolver reads it (SEC-AP2). */
    statusCategories?: string[];
    /** W5: mirrors the list's rail filter — an export of "my opened set" is exactly that set. */
    openedByOperatorId?: string;
    /** ⭐ W24: mirrors the list's search — an export of a searched screen is exactly that screen (SEC-AP2). */
    search?: string;
    /** ⭐ W27: mirrors the list's shelf filter WITH its permission — see `ExportFilters` in chats.proto. */
    shelved?: string;
  };
}
interface ListWire {
  pageSize?: number;
  cursor?: string;
}
interface GetWire {
  exportId?: string;
}
interface BatchWire {
  limit?: number;
}

/** Defaults when a caller does not say (the worker always does). */
const DEFAULT_RUN_LIMIT = 5;
const DEFAULT_EXPIRE_LIMIT = 100;
/** A claim older than this means the producer died — see `ExportMaintenance.runDueExports`. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const toWire = (r: ExportJobRow) => ({
  id: r.id,
  scope: r.scope,
  format: r.format,
  status: r.status,
  rowCount: r.row_count ?? 0,
  byteSize: String(r.byte_size ?? 0), // int64 on the wire must be a string (grpc longs:String)
  failureReason: r.failure_reason ?? '',
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at ? r.completed_at.toISOString() : '',
  // `requestedBy` and `uploadId` are deliberately NOT on the wire — see chats.proto.
});

/**
 * The export gRPC surface (feature 017, US1 — roadmap 4.10).
 *
 * Permission enforcement is at BOTH tiers (Principle II): the gateway resolves the scope's key from the
 * URL and this service re-checks it inside `ExportService.create`, against the permissions the gateway
 * forwarded. Neither tier trusts the other.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ExportController {
  constructor(
    @Inject(ExportService) private readonly service: ExportService,
    @Inject(ExportRepository) private readonly repo: ExportRepository,
    @Inject(ExportMaintenance) private readonly maintenance: ExportMaintenance,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  @GrpcMethod('ChatsExportService', 'CreateExport')
  async createExport(req: CreateWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const permissions = readActorPermissions(metadata);
    const f = req?.filters ?? {};

    /**
     * ⭐ Feature 032 — the SAME decoder the list uses (`status/status-filter.ts`), not a second reading
     * of the same fields. This edge is where the two vocabularies drifted once already: feature 017
     * accepted the enum name and cast it straight into the DB filter, producing an empty file that
     * reported success. One function now, and the parity test polices the contract beside it.
     */
    let statusIn: string[] | undefined;
    try {
      statusIn = await resolveStatusFilter(this.statuses, ctx.accountId, f);
    } catch (e) {
      if (e instanceof StatusFilterError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: e.message });
      }
      throw e;
    }

    /**
     * ⭐ W27 / 036: the shelf filter, mirrored with its PERMISSION — the list read this export
     * mirrors is gated, so the mirror is gated identically (an export must never answer a question
     * the screen would refuse). Unknown value refused, never dropped (the slaOutcome lesson,
     * beside which this sits).
     */
    const shelved = (f.shelved ?? '').trim();
    if (shelved !== '') {
      if (!isShelfState(shelved)) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid shelved' });
      }
      if (!hasPermission(permissions, 'crm.conversation.shelf.view')) {
        throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
      }
    }

    try {
      const row = await this.service.create(
        {
          accountId: ctx.accountId,
          requestedBy: ctx.userId,
          permissions,
          scopeName: String(req?.scope ?? ''),
          /**
           * The filter set for production.
           *
           * ⚠️ The status filter is decoded ABOVE, by the shared resolver — see the note there for what
           * this edge got wrong in feature 017 and why the decoding is no longer written twice.
           *
           * `brandIn` intersects with the caller's permitted brands, the same narrowing the conversation
           * list applies — an export cannot widen a caller's reach.
           */
          filters: {
            ...(statusIn === undefined ? {} : { statusIn }),
            ...(f.priority ? { priority: f.priority } : {}),
            ...(f.assigneeOperatorId ? { assigneeOperatorId: f.assigneeOperatorId } : {}),
            ...(f.playerId ? { playerId: f.playerId } : {}),
            // The SAME brand narrowing the conversation list applies (R3): an export can never widen
            // a caller's reach, and an unpermitted brand yields an empty set rather than everything.
            ...(() => {
              const brandIn = resolveBrandIn(ctx, f.brandId);
              return brandIn ? { brandIn } : {};
            })(),
            // Carried through as the OUTCOME; the producer resolves it into an id set at production
            // time, the same way the list resolves it when it reads. Dropping it here is what Track B
            // caught: a request for breached conversations produced every conversation.
            ...(() => {
              const outcome = this.slaOutcomeOf(f.slaOutcome);
              return outcome ? { slaOutcome: outcome } : {};
            })(),
            ...(f.channel ? { channel: f.channel } : {}),
            // W5: the rail filter, mirrored end to end for the SEC-AP2 reason the proto states.
            ...(f.openedByOperatorId ? { openedByOperatorId: f.openedByOperatorId } : {}),
            // ⭐ W24: the search, cleaned exactly as the list cleans it.
            ...(() => {
              const search = cleanSearch(f.search);
              return search ? { search } : {};
            })(),
            // ⭐ W27: validated + permission-checked above; absent = the exclusion default.
            ...(shelved ? { shelved: shelved as 'suspended' | 'deleted' } : {}),
          },
          // The stored filter set, for production on a later tick. Stored DECODED, so `filtersOf` reads
          // DB values and no second decode step can be forgotten there.
          rawFilters: {
            ...(statusIn === undefined ? {} : { statusIn }),
            ...(f.priority ? { priority: f.priority } : {}),
            ...(f.assigneeOperatorId ? { assigneeOperatorId: f.assigneeOperatorId } : {}),
            ...(f.playerId ? { playerId: f.playerId } : {}),
            ...(f.brandId ? { brandIn: [f.brandId] } : {}),
            ...(() => {
              const outcome = this.slaOutcomeOf(f.slaOutcome);
              return outcome ? { slaOutcome: outcome } : {};
            })(),
            ...(f.channel ? { channel: f.channel } : {}),
            // W5: stored too — `filtersOf` reads DB values, and a filter accepted here and absent
            // there is the exact drop this file already paid for once with `slaOutcome`.
            ...(f.openedByOperatorId ? { openedByOperatorId: f.openedByOperatorId } : {}),
            // ⭐ W24: stored CLEANED, so production applies exactly the operand the screen used.
            ...(() => {
              const search = cleanSearch(f.search);
              return search ? { search } : {};
            })(),
            // ⭐ W27: stored too — a filter accepted here and absent from `filtersOf`'s read is the
            // exact drop this file already paid for once with `slaOutcome`.
            ...(shelved ? { shelved } : {}),
          },
        },
        new Date(),
      );
      return toWire(row);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  @GrpcMethod('ChatsExportService', 'ListExports')
  async listExports(req: ListWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    let cursor;
    try {
      cursor = decodeCursor(req?.cursor);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid cursor' });
      }
      throw err;
    }
    const page = await this.repo.listOwn(
      ctx.accountId,
      ctx.userId,
      clampPageSize(req?.pageSize),
      cursor,
    );
    return {
      exports: page.rows.map(toWire),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : '',
    };
  }

  @GrpcMethod('ChatsExportService', 'GetExport')
  async getExport(req: GetWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const row = await this.repo.getOwned(ctx.accountId, String(req?.exportId ?? ''), ctx.userId);
    // Unknown id, another account's id, and a same-account NON-OWNER's id all land here (FR-011).
    // One answer for four situations: no existence oracle.
    if (!row) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toWire(row);
  }

  @GrpcMethod('ChatsExportService', 'ResolveExportArtefact')
  async resolveExportArtefact(req: GetWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const row = await this.repo.getOwned(ctx.accountId, String(req?.exportId ?? ''), ctx.userId);
    if (!row) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    /**
     * The order below is the design, and it was corrected once: expiry is checked BEFORE readiness.
     *
     * An EXPIRED export is NOT FOUND, never 410/GONE — confirming that something existed is an existence
     * oracle for an object that is deliberately unrecoverable. And "past the window but not yet swept"
     * must give the SAME answer as "swept", because both expiries are driven by ticks and there is always
     * an interval between them. A refusal that depended on a scheduler having run would not be a
     * security property.
     *
     * Only then may a non-terminal status be reported, and only to the OWNER — who has already been
     * established by `getOwned` and is polling for exactly this. Checking readiness first would have made
     * this branch unreachable (every non-`ready` row has a null `upload_id`) and answered a waiting owner
     * with `not found`, which reads as "your export is lost".
     */
    if (
      row.status === 'expired' ||
      row.status === 'failed' ||
      row.expires_at.getTime() <= Date.now()
    ) {
      // `failed` joins the NOT_FOUND group, and Track B is why: a failed export has no artefact and never
      // will, so "there is nothing here" is the true answer. It had been reported as
      // FAILED_PRECONDITION → 400 *invalid request*, which blames the caller for a request that was fine.
      // The failure REASON is on `GET /exports/:id`, where the owner can act on it (FR-015).
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    if (row.status !== 'ready') {
      // Only `queued` / `running` reach here: not ready YET, keep polling. Visible to the owner alone,
      // who has already been established by `getOwned`.
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: row.status });
    }
    if (!row.upload_id) {
      // A `ready` row with no artefact reference should be impossible — the reference is written in the
      // same transaction as the status. Refused as absent rather than trusted, because the alternative is
      // asking storage for upload id `""`.
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    return {
      uploadId: row.upload_id,
      displayName: `${row.scope}-${row.created_at.toISOString().slice(0, 10)}.csv`,
    };
  }

  // ── Maintenance: system actor only, no gateway route, counts-only ─────────────────────────────

  @GrpcMethod('ChatsMaintenanceService', 'RunDueExports')
  async runDueExports(req: BatchWire, metadata: Metadata) {
    this.assertSystem(metadata);
    const limit = Math.trunc(Number(req?.limit ?? 0)) || DEFAULT_RUN_LIMIT;
    const res = await this.maintenance.runDueExports(limit, new Date(), STALE_CLAIM_MS);
    return {
      claimed: res.claimed,
      completed: res.completed,
      failed: res.failed,
      recoveredStale: res.recoveredStale,
    };
  }

  @GrpcMethod('ChatsMaintenanceService', 'ExpireDueExports')
  async expireDueExports(req: BatchWire, metadata: Metadata) {
    this.assertSystem(metadata);
    const limit = Math.trunc(Number(req?.limit ?? 0)) || DEFAULT_EXPIRE_LIMIT;
    return this.maintenance.expireDueExports(limit, new Date());
  }

  /**
   * Decode the SLA filter, refusing a value the wire does not define.
   *
   * `null` from `wireToSlaOutcome` means "the wire carried something, and it is not a member" — refused
   * as INVALID_ARGUMENT rather than dropped, because dropping WIDENS the export. `undefined` means no
   * filter, which is a legitimate request.
   */
  private slaOutcomeOf(wire: string | undefined): string | undefined {
    const outcome = wireToSlaOutcome(wire);
    if (outcome === null) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid sla_outcome' });
    }
    return outcome;
  }

  /** A user session must never reach a cross-account path, even a counts-only one (014's rule). */
  private assertSystem(metadata: Metadata): void {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
  }

  private mapError(err: unknown): RpcException {
    if (err instanceof UnknownScopeError) {
      return new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'unknown scope' });
    }
    if (err instanceof ExportForbiddenError) {
      return new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    if (err instanceof QuotaExhaustedError) {
      return new RpcException({ code: GrpcStatus.RESOURCE_EXHAUSTED, message: 'quota exhausted' });
    }
    if (err instanceof RpcException) return err;
    return new RpcException({ code: GrpcStatus.INTERNAL, message: 'internal' });
  }
}
