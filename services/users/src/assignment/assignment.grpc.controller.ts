import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { AssignmentService, type AssignmentOutcome } from './assignment.service';
import type { AssignmentRow } from './assignment.repository';

/**
 * `PlayerAssignmentService` — the assignment WRITES (feature 026, roadmap 5.7).
 *
 * A separate gRPC service from `UsersReadService` because a write on a service named *Read* is a lie
 * in the contract, and `tests/users-read/no-outbound.spec.ts` enforces it. New service, EXISTING
 * package, so no new hosting entry is needed — a claim `hosting.spec.ts` verifies rather than accepts.
 *
 * ⚠️ **The permission is checked HERE as well as at the gateway.** Feature 011's two-tier rule: a
 * call that skips the gateway is refused on the same grounds, and the service never assumes the edge
 * did its job.
 *
 * ⚠️ **Attachment grants access, and self-assignment is deliberate.** `users.player.assign` is an
 * intended route to the `am_only` tier — attach, read, detach. That is the capability the operator
 * asked for; the control is the audit trail, not a refusal here. Do not "fix" it.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

const ASSIGN_KEY = 'users.player.assign';

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

/**
 * ⚠️ Wire values are decoded by NAME as well as by tag.
 *
 * Feature 025 lost a live iteration to exactly this: proto-loader is configured with `enums: String`,
 * so a response carries `"ASSIGNMENT_STATUS_OK"` and not `1`. Writes kept working while reads broke,
 * so every unit test stayed green. Encoding by name here means the gateway can compare either.
 */
const STATUS = {
  ok: 'ASSIGNMENT_STATUS_OK',
  unchanged: 'ASSIGNMENT_STATUS_UNCHANGED',
  forbidden: 'ASSIGNMENT_STATUS_FORBIDDEN',
  no_such_player: 'ASSIGNMENT_STATUS_NO_SUCH_PLAYER',
  no_such_manager: 'ASSIGNMENT_STATUS_NO_SUCH_MANAGER',
  already_assigned: 'ASSIGNMENT_STATUS_ALREADY_ASSIGNED',
} as const;

export const toAssignmentWire = (row: AssignmentRow | null) =>
  row
    ? {
        brandId: row.brand_id,
        playerId: row.player_id,
        amAuthUserId: row.am_auth_user_id,
        assignedBy: row.assigned_by,
        startedAt: row.started_at.toISOString(),
        endedAt: row.ended_at?.toISOString() ?? '',
      }
    : undefined;

interface AssignWire {
  brandId?: string;
  playerId?: string;
  amAuthUserId?: string;
}

@Controller()
export class AssignmentController {
  constructor(@Inject(AssignmentService) private readonly assignments: AssignmentService) {}

  @GrpcMethod('PlayerAssignmentService', 'AssignPlayer')
  async assignPlayer(req: AssignWire, metadata: Metadata) {
    const ctx = this.actor(metadata);
    if (!ctx) return { status: STATUS.forbidden };

    const brandId = (req?.brandId ?? '').trim();
    const playerId = (req?.playerId ?? '').trim();
    if (!brandId || !playerId) return { status: STATUS.no_such_player };

    const outcome = await this.assignments.assign(
      ctx.accountId,
      { brandId, playerId },
      (req?.amAuthUserId ?? '').trim(),
      ctx.userId,
    );
    return this.reply(outcome);
  }

  @GrpcMethod('PlayerAssignmentService', 'UnassignPlayer')
  async unassignPlayer(req: AssignWire, metadata: Metadata) {
    const ctx = this.actor(metadata);
    if (!ctx) return { status: STATUS.forbidden };

    const brandId = (req?.brandId ?? '').trim();
    const playerId = (req?.playerId ?? '').trim();
    if (!brandId || !playerId) return { status: STATUS.no_such_player };

    const outcome = await this.assignments.unassign(ctx.accountId, { brandId, playerId }, ctx.userId);
    return this.reply(outcome);
  }

  /**
   * The caller, or `null` when they may not be here at all.
   *
   * ⚠️ Refused under a view-as preview: a read-only preview that could hand somebody a portfolio —
   * and with it access to a customer's private data — would not be read-only. Features 024 and 025
   * draw the same line for the same reason.
   */
  private actor(metadata: Metadata): { accountId: string; userId: string } | null {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const userId = readStr(metadata, 'x-actor-user-id');
    if (!accountId || !userId) return null;
    if (readStr(metadata, 'x-is-preview') === 'true') return null;
    if (!may(metadata, ASSIGN_KEY)) return null;
    return { accountId, userId };
  }

  /** One shape per outcome — no branch can collapse two different refusals into one answer. */
  private reply(outcome: AssignmentOutcome) {
    switch (outcome.status) {
      case 'ok':
        return { status: STATUS.ok, assignment: toAssignmentWire(outcome.assignment) };
      case 'unchanged':
        return { status: STATUS.unchanged, assignment: toAssignmentWire(outcome.assignment) };
      case 'already_assigned':
        // The current holder is returned deliberately: a caller told "somebody else has them" and
        // not told who has to go and look, and the answer is not a secret from somebody who already
        // holds the assignment key.
        return { status: STATUS.already_assigned, assignment: toAssignmentWire(outcome.assignment) };
      case 'no_such_manager':
        return { status: STATUS.no_such_manager };
      default:
        return { status: STATUS.no_such_player };
    }
  }
}
