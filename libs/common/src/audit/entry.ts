import { isAuditAction, type AuditAction } from './catalogue';
import { parseDetail, type AuditDetail } from './detail';

/**
 * The shared audit-entry shape (feature 015).
 *
 * The TABLE is duplicated per service — it cannot be shared (one database per service, Principle VIII) and
 * the entry must be written inside the transaction of the action it describes (spec Q3). The SHAPE and the
 * VOCABULARY are shared here, so three services and the gateway agree on what an entry is without a shared
 * table, and `tests/data-model/audit-entry-identity.spec.ts` keeps the three schemas from drifting.
 *
 * Pure module: types + validation + wire mapping. No Prisma, no I/O, no clock.
 */

export type ActorKind = 'user' | 'system';

/** What a writer supplies. `accountId` comes from the caller context, never from a request body. */
export interface AuditEntryInput {
  action: AuditAction;
  actorUserId: string;
  targetRef: string;
  /** `system` for a caller-less action; then `actorRef` names the rule and the authority it used. */
  actorKind?: ActorKind;
  actorRef?: string;
  /** Owner view-as marker. The previewed ROLE is never the actor — nobody performed anything as it. */
  underPreview?: boolean;
  detail?: unknown;
}

/** A validated entry, ready to be written. */
export interface AuditEntryData {
  action: AuditAction;
  actor_user_id: string;
  actor_kind: ActorKind;
  actor_ref: string | null;
  under_preview: boolean;
  target_ref: string;
  detail_json: AuditDetail | null;
}

/** A row as read back from any of the three tables. */
export interface AuditEntryRow {
  id: string;
  actor_user_id: string;
  actor_kind: string;
  actor_ref: string | null;
  under_preview: boolean;
  action: string;
  target_ref: string;
  detail_json: unknown;
  created_at: Date;
}

export class AuditEntryError extends Error {}

/**
 * Validate a writer's input. Refuses rather than defaults, on every axis:
 * an unknown action, a missing actor, a missing target, or a detail that is not expressible.
 */
export function buildEntry(input: AuditEntryInput): AuditEntryData {
  if (!isAuditAction(input.action)) throw new AuditEntryError('unknown audit action');
  const actorKind: ActorKind = input.actorKind ?? 'user';

  const actorUserId = (input.actorUserId ?? '').trim();
  if (actorKind === 'user' && !actorUserId) {
    // An entry with no actor answers nobody's question. "The system did it" is only acceptable when it
    // actually was the system, and then `actor_ref` has to say which rule (FR-006).
    throw new AuditEntryError('an audit entry needs an actor');
  }
  const actorRef = (input.actorRef ?? '').trim();
  if (actorKind === 'system' && !actorRef) {
    throw new AuditEntryError('a system actor must name the rule and authority it acted with');
  }

  const targetRef = (input.targetRef ?? '').trim();
  if (!targetRef) throw new AuditEntryError('an audit entry needs a target reference');

  return {
    action: input.action,
    actor_user_id: actorUserId,
    actor_kind: actorKind,
    actor_ref: actorRef || null,
    under_preview: input.underPreview === true,
    target_ref: targetRef,
    detail_json: parseDetail(input.action, input.detail) ?? null,
  };
}

/** Wire shape per the contract: enum NAMES, RFC3339 timestamps, `detail_json` as a string. */
export function toAuditEntryWire(row: AuditEntryRow, source: string) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorKind: row.actor_kind === 'system' ? 'ACTOR_KIND_SYSTEM' : 'ACTOR_KIND_USER',
    actorRef: row.actor_ref ?? '',
    underPreview: row.under_preview,
    action: row.action,
    targetRef: row.target_ref,
    detailJson: row.detail_json ? JSON.stringify(row.detail_json) : '',
    createdAt: row.created_at.toISOString(),
    source,
  };
}
