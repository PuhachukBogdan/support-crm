import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';

/**
 * W27 / feature 036 (roadmap 9.16) — the SHELF, spelled once.
 *
 * A conversation's third place: out of every queue, not gone. `suspended` is work held back
 * (a supervisor's hand today; spam/abuse rules later call the same rpc); `deleted` is soft and
 * recoverable (a future deletion schedule — 12.12/W32 — empties that bucket; nothing here does).
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────────────
 * The state is only worth anything if EVERY query that feeds work excludes it, and an exclusion
 * spelled per-file is an exclusion the next list forgets. So the predicate value, the transition
 * table and the mutation guard all live here — `shelf.exclusion.spec.ts` walks the consuming
 * sites and fails when one stops importing the predicate.
 *
 * ⚠️ Named `shelf`, not `hold`: `assignment/capacity.ts` already uses "held" for an operator's
 * open work, and one word with two meanings in one service is a trap for every future reader.
 */

export const SHELF_STATES = ['suspended', 'deleted'] as const;
export type ShelfState = (typeof SHELF_STATES)[number];

export const isShelfState = (raw: string): raw is ShelfState =>
  (SHELF_STATES as readonly string[]).includes(raw);

/**
 * The ONE exclusion every work-feeding query spreads into its `where` (lists, unseen count,
 * backlog enqueue+drain, pool load, exports). A bucket list is the only reader that replaces it.
 */
export const NOT_SHELVED = { shelved_state: null } as const;

/**
 * The transition table — audit action per (from, to). `null` from-state = ordinary.
 *
 *   NONE → suspended = conversation.suspend      NONE → deleted = conversation.delete
 *   suspended → NONE = conversation.release      deleted → NONE = conversation.restore
 *   suspended → deleted = conversation.delete    (delete wins; restore returns to NONE)
 *   deleted → suspended = REFUSED                (restore first — a delete must be undone
 *                                                 deliberately, never sideways)
 *   same → same = UNCHANGED                      (no write, no audit entry — FR-010)
 */
export type ShelfTransition =
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: string }
  | { kind: 'change'; action: ShelfAuditAction };

export type ShelfAuditAction =
  | 'conversation.suspend'
  | 'conversation.release'
  | 'conversation.delete'
  | 'conversation.restore';

/** Entering a shelf state names the state's own verb; delete keeps its word over suspended. */
const ENTER_ACTION: Readonly<Record<ShelfState, ShelfAuditAction>> = {
  suspended: 'conversation.suspend',
  deleted: 'conversation.delete',
};
/** Leaving names what is being UNDONE — the from-state decides, spelled as data, not a branch. */
const LEAVE_ACTION: Readonly<Record<ShelfState, ShelfAuditAction>> = {
  suspended: 'conversation.release',
  deleted: 'conversation.restore',
};

export function shelfTransition(from: string | null, to: ShelfState | null): ShelfTransition {
  const f = from && isShelfState(from) ? from : null;
  if (f === to) return { kind: 'unchanged' };
  if (to === 'suspended' && f === 'deleted') return { kind: 'refused', reason: 'restore first' };
  if (to) return { kind: 'change', action: ENTER_ACTION[to] };
  // to === null — back to ordinary. `f` is non-null here (f === to was handled above).
  return { kind: 'change', action: LEAVE_ACTION[f as ShelfState] };
}

/**
 * The mutation guard: while shelved, the ONLY verb a conversation accepts is the shelf rpc itself.
 * Called by every OPERATOR-actor mutation entry point; deliberately NOT by the delivery append —
 * an inbound customer message is stored (mail is not bounced), and "it wakes nothing" is already
 * true by the predicates above, not by a special case (FR-012).
 *
 * FAILED_PRECONDITION, not PERMISSION_DENIED: the caller may be perfectly entitled — the OBJECT is
 * in a state where the act is meaningless, and the gateway maps this to 409.
 */
export function assertNotShelved(row: { shelved_state?: string | null } | null): void {
  if (row?.shelved_state) {
    throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'conversation is shelved' });
  }
}
