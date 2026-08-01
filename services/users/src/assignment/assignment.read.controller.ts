import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '@crm/common';
import { AssignmentRepository } from './assignment.repository';
import { toAssignmentWire } from './assignment.grpc.controller';

/**
 * The assignment READS, on `UsersReadService` (feature 026, roadmap 5.7).
 *
 * A third controller on an existing gRPC service is the shape this package already uses — the audit
 * reader and the presence reader sit beside the player handlers. Splitting by SUBJECT keeps each
 * readable; Nest composes the handlers, and `hosting.spec.ts` asserts none is silently dropped.
 *
 * ── Who may read what ───────────────────────────────────────────────────────────────────────────
 *   • **Who looks after this player** — the same clearance as seeing the player at all
 *     (`crm.contact.view`). Knowing which colleague owns a customer is not more sensitive than the
 *     customer record itself.
 *   • **My own portfolio** — no extra key. It is a fact about the caller's own work.
 *   • **Somebody ELSE's portfolio** — `users.list.view`. *"Show me another manager's book of
 *     business"* is a supervisory question, and it is the same fact class as seeing the staff list,
 *     reused rather than inventing a second key nobody would think to grant.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const may = (md: Metadata | undefined, key: string): boolean =>
  readStr(md, 'x-actor-permissions')
    .split(',')
    .map((s) => s.trim())
    .includes(key);

interface GetWire {
  brandId?: string;
  playerId?: string;
}
interface ListWire {
  amAuthUserId?: string;
  pageSize?: number;
  pageToken?: string;
}

@Controller()
export class AssignmentReadController {
  constructor(@Inject(AssignmentRepository) private readonly repo: AssignmentRepository) {}

  @GrpcMethod('UsersReadService', 'GetPlayerAssignment')
  async getPlayerAssignment(req: GetWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const brandId = (req?.brandId ?? '').trim();
    const playerId = (req?.playerId ?? '').trim();
    if (!accountId || !brandId || !playerId) return {};
    if (!may(metadata, 'crm.contact.view')) return {};

    const row = await this.repo.activeFor(accountId, { brandId, playerId });
    // ⚠️ An EMPTY answer means "nobody looks after this player" — a real and common state, not an
    // error. A caller distinguishes it by the absent manager id, not by a status.
    return toAssignmentWire(row) ?? {};
  }

  @GrpcMethod('UsersReadService', 'ListAssignedPlayers')
  async listAssignedPlayers(req: ListWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const caller = readStr(metadata, 'x-actor-user-id');
    if (!accountId || !caller) return { assignments: [], nextPageToken: '' };

    const subject = (req?.amAuthUserId ?? '').trim() || caller;
    // Somebody else's book of business is a supervisory question.
    if (subject !== caller && !may(metadata, 'users.list.view')) {
      return { assignments: [], nextPageToken: '' };
    }

    const limit = clampPageSize(req?.pageSize);
    let after: { startedAt: Date; id: string } | undefined;
    if (req?.pageToken) {
      try {
        // ⚠️ The shared cursor's field is named `createdAt` because it was written for tables whose
        // ordering column is. Here the ordering column is `started_at`, and it carries that value.
        // Reusing the shared shape rather than minting a second cursor format keeps every paged read
        // in this product decodable by one function — the alternative is two formats that drift.
        const c = decodeCursor(req.pageToken);
        if (c?.createdAt && c?.id) after = { startedAt: new Date(c.createdAt), id: c.id };
      } catch (err) {
        // A malformed cursor is a caller defect, not a reason to silently serve page one — that
        // would look like the list restarting and hide the bug.
        if (err instanceof InvalidCursorError) return { assignments: [], nextPageToken: '' };
        throw err;
      }
    }

    // One extra row decides whether there is a next page, without a COUNT (Principle VII).
    const rows = await this.repo.listActiveFor(accountId, subject, limit + 1, after);
    const page = rows.slice(0, limit);
    const next =
      rows.length > limit && page.length > 0
        ? encodeCursor({
            createdAt: page[page.length - 1]!.started_at.toISOString(),
            id: page[page.length - 1]!.id,
          })
        : '';

    return { assignments: page.map((r) => toAssignmentWire(r)), nextPageToken: next };
  }
}
