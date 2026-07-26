import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { AuditCursorError, toAuditEntryWire } from '@crm/common';
import { AuditAccessGuard } from './audit.guard';
import { RequiresAuditPermission } from './requires-audit-permission.decorator';
import { AUDIT_SOURCE, AuditFilterError, AuditRepository } from './audit.repository';

interface ListWire {
  actorUserId?: string;
  action?: string;
  actionClass?: string;
  targetRef?: string;
  from?: string;
  to?: string;
  pageToken?: string;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

function clampPageSize(requested: number | undefined): number {
  if (!requested || requested <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/** Which filter dimensions the caller used. Names only — never their values. */
function usedFilters(req: ListWire): string[] {
  return (['actorUserId', 'action', 'actionClass', 'targetRef', 'from', 'to'] as const).filter(
    (k) => ((req?.[k] ?? '') as string).trim().length > 0,
  );
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * One source of the federated audit read (feature 015, roadmap 4.8). **Identical in auth, users and chats** —
 * the gateway queries all three and merges them into one ordered log.
 *
 * Gated by `platform.audit.view` at this tier as well as at the gateway (Principle II): a call that skips
 * the gateway carries no permission context and is refused.
 *
 * There is deliberately **no write handler**. Entries are written in-process, inside the transaction of the
 * action they describe (spec Q3), so exposing a write RPC would both break that guarantee and create a
 * mutation surface where append-only requires none.
 */
@Controller()
@UseGuards(AuditAccessGuard)
export class AuditReadController {
  constructor(@Inject(AuditRepository) private readonly audit: AuditRepository) {}

  @GrpcMethod('AuthService', 'ListAuditEntries')
  @RequiresAuditPermission('platform.audit.view')
  async listAuditEntries(req: ListWire, metadata: Metadata) {
    const accountId = readMeta(metadata, 'x-actor-account-id');
    if (!accountId) {
      // Fail-closed: no account context, no tenant data.
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }

    const pageToken = (req?.pageToken ?? '').trim() || undefined;
    try {
      const { rows, nextPageToken } = await this.audit.list(
        accountId,
        {
          actorUserId: (req?.actorUserId ?? '').trim() || undefined,
          action: (req?.action ?? '').trim() || undefined,
          actionClass: (req?.actionClass ?? '').trim() || undefined,
          targetRef: (req?.targetRef ?? '').trim() || undefined,
          from: (req?.from ?? '').trim() || undefined,
          to: (req?.to ?? '').trim() || undefined,
        },
        clampPageSize(req?.pageSize),
        pageToken,
      );
      // Reading the log is itself a sensitive act: "who went looking at who accessed what" is the same
      // accountability question one level up, and an unaudited audit reader defeats the point.
      //
      // Written HERE rather than at the gateway for two reasons. The gateway owns no database (Principle
      // VIII), and adding a write RPC would contradict the design: entries are written in-process, inside the
      // transaction of the action they describe, so no caller-facing write surface exists at all.
      //
      // Auth is always one of the federated sources, so recording it here yields exactly ONE entry per read.
      // Only on the FIRST page: the unit being recorded is a read, not a page of one.
      //
      // Deliberately NOT swallowed. If we cannot record that someone read the trail, we do not show them the
      // trail — the same strictness every other v1 class gets (spec Q3).
      if (!pageToken) {
        await this.audit.append(accountId, {
          action: 'audit.read',
          actorUserId: readMeta(metadata, 'x-actor-user-id'),
          underPreview: readMeta(metadata, 'x-is-preview') === 'true',
          targetRef: accountId,
          // Which dimensions were filtered on — NAMES only. A target id would be harmless; a free-text
          // filter would not, and nothing here can tell them apart. Names answer the question that matters:
          // was this a targeted look, or a sweep?
          detail: { filters: usedFilters(req) },
        });
      }

      return {
        entries: rows.map((r) => toAuditEntryWire(r, AUDIT_SOURCE)),
        nextPageToken,
      };
    } catch (err) {
      if (err instanceof AuditFilterError || err instanceof AuditCursorError) {
        // A filter the vocabulary does not know is a client error. Refusing it is the point: ignoring it
        // would widen the query to everything and look like a successful search.
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: err.message });
      }
      throw err;
    }
  }
}
