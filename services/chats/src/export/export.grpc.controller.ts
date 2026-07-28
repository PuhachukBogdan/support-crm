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
import { ChatsAccessGuard } from '../security/permission.guard';
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
    status?: string;
    priority?: string;
    assigneeOperatorId?: string;
    playerId?: string;
    brandId?: string;
    slaOutcome?: string;
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
  ) {}

  @GrpcMethod('ChatsExportService', 'CreateExport')
  async createExport(req: CreateWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const permissions = readActorPermissions(metadata);
    const f = req?.filters ?? {};

    try {
      const row = await this.service.create(
        {
          accountId: ctx.accountId,
          requestedBy: ctx.userId,
          permissions,
          scopeName: String(req?.scope ?? ''),
          // The filter set for production. `brandIn` intersects with the caller's permitted brands, the
          // same narrowing the conversation list applies — an export cannot widen a caller's reach.
          filters: {
            ...(f.status ? { status: f.status as never } : {}),
            ...(f.priority ? { priority: f.priority } : {}),
            ...(f.assigneeOperatorId ? { assigneeOperatorId: f.assigneeOperatorId } : {}),
            ...(f.playerId ? { playerId: f.playerId } : {}),
            // The SAME brand narrowing the conversation list applies (R3): an export can never widen
            // a caller's reach, and an unpermitted brand yields an empty set rather than everything.
            ...(() => {
              const brandIn = resolveBrandIn(ctx, f.brandId);
              return brandIn ? { brandIn } : {};
            })(),
          },
          rawFilters: {
            ...(f.status ? { status: f.status } : {}),
            ...(f.priority ? { priority: f.priority } : {}),
            ...(f.assigneeOperatorId ? { assigneeOperatorId: f.assigneeOperatorId } : {}),
            ...(f.playerId ? { playerId: f.playerId } : {}),
            ...(f.brandId ? { brandIn: [f.brandId] } : {}),
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

    // An EXPIRED export is NOT FOUND, not 410/GONE: confirming that something existed is an existence
    // oracle for an object that is deliberately gone.
    if (row.status === 'expired' || !row.upload_id) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    if (row.status !== 'ready') {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: row.status });
    }
    if (row.expires_at.getTime() <= Date.now()) {
      // Past the window but not yet swept. The answer must not depend on how recently a tick ran.
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
