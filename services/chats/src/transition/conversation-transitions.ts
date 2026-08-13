import { randomUUID } from 'node:crypto';
import type { Metadata } from '@grpc/grpc-js';
import { buildTransitionDims, type DimsSource } from './transition.dims';
import type { RecordTransitionInput } from './transition.recorder';
import type { SubjectSource } from '../subject/subject.derive';

/**
 * Shaping a conversation transition, in one place (feature 023, roadmap 4.8a).
 *
 * ── Why this module exists ───────────────────────────────────────────────────────────────────────
 * FIVE code paths write `status` or `assignee_operator_id`, and the structural guard
 * `sanctioned-writers.spec.ts` requires every one of them to record. Without a shared builder the
 * same five would each decide independently what the payload looks like, what counts as the actor,
 * and which columns go into the snapshot — five chances to drift, and drift here is invisible
 * because a transition with the wrong shape still inserts fine.
 *
 * ⚠️ The fifth writer (`round-robin-state.repository.ts`, auto-assignment) was NOT in the manual
 * inventory — the guard found it. That is the argument for both the guard and this builder.
 */

/** Who caused the change. `correlationId` ties this to the audit entry from the same act. */
export interface TransitionActor {
  kind: 'user' | 'system' | 'integration';
  /** A user id, or the rule / job that acted. Never empty for a system act — the recorder refuses it. */
  ref: string;
  correlationId: string;
}

/** One act, one id. Generated at the edge so every record of that act shares it. */
export const newCorrelationId = (): string => randomUUID();

/** A user-initiated act, from the caller context the controllers already read. */
export const userActor = (userId: string, correlationId = newCorrelationId()): TransitionActor => ({
  kind: 'user',
  ref: userId,
  correlationId,
});

/**
 * A rule- or job-initiated act. `ref` names the rule so "who did this" is answerable — an automation
 * that changes a status is exactly the case where "the system" is not an acceptable answer.
 */
export const systemActor = (ref: string, correlationId = newCorrelationId()): TransitionActor => ({
  kind: 'system',
  ref,
  correlationId,
});

/** The columns a transition needs from the conversation BEFORE the change. */
export interface ConversationBefore extends DimsSource {
  id: string;
  status?: string | null;
}

/** The Prisma `select` that reads exactly those columns and nothing else. */
export const TRANSITION_BEFORE_SELECT = {
  id: true,
  status: true,
  brand_id: true,
  channel: true,
  assignee_operator_id: true,
} as const;

function base(
  accountId: string,
  before: ConversationBefore,
  actor: TransitionActor,
  occurredAt: Date,
  metadata?: Metadata,
): Omit<RecordTransitionInput, 'type' | 'payload'> {
  return {
    accountId,
    occurredAt,
    actorKind: actor.kind,
    actorRef: actor.ref,
    subjectKind: 'conversation',
    subjectId: before.id,
    // The snapshot is taken from the row as it was BEFORE the change — the dimensions in force when
    // the event happened, not the ones it produced (FR-003).
    dims: buildTransitionDims(before, metadata),
    correlationId: actor.correlationId,
  };
}

/**
 * `conversation.first_public_reply` — the envelope only; the caller supplies `{ messageId }`.
 *
 * Split this way because the message id is known only after the row is created, while everything else
 * is known before. Returning the base keeps the "one place shapes a transition" rule intact without
 * pretending the caller has nothing to add.
 */
export function firstPublicReplyBase(
  accountId: string,
  before: ConversationBefore,
  actor: TransitionActor,
  occurredAt: Date,
  metadata?: Metadata,
): Omit<RecordTransitionInput, 'payload'> {
  return {
    ...base(accountId, before, actor, occurredAt, metadata),
    type: 'conversation.first_public_reply',
  };
}

/** `conversation.status_changed` — `from` may be absent on a row that had none. */
export function statusChanged(
  accountId: string,
  before: ConversationBefore,
  to: string,
  actor: TransitionActor,
  occurredAt: Date,
  metadata?: Metadata,
): RecordTransitionInput {
  return {
    ...base(accountId, before, actor, occurredAt, metadata),
    type: 'conversation.status_changed',
    payload: { from: before.status ?? null, to },
  };
}

/**
 * `conversation.subject_set` — who named the conversation, and when (FR-025).
 *
 * ⚠️ The payload is `{ source }` and nothing else. The title is the CUSTOMER's own words; carrying it
 * here would put customer text into an append-only store. The current value lives on the conversation
 * row, where it can be corrected; this records only that it was set, by whom and when — which is why
 * `subject_set_by` / `subject_set_at` are NOT columns (data-model §4).
 */
export function subjectSet(
  accountId: string,
  before: ConversationBefore,
  /**
   * `auto` (we derived it) · `manual` (a person typed it) · `source` (⭐ feature 033: the source named
   * it — an email's `Subject`). All three are the same KIND of fact and belong in one type; three
   * transition types would be three vocabularies free to drift.
   *
   * ⓘ `source` reaches here only if a future writer records a transition for a source-given title.
   * Channel intake today writes the column at CREATION, where there is no prior value to transition
   * from — the conversation's own creation is the record. The parameter accepts it so that writer does
   * not have to widen this signature under a deadline.
   */
  source: SubjectSource,
  actor: TransitionActor,
  occurredAt: Date,
  metadata?: Metadata,
): RecordTransitionInput {
  return {
    ...base(accountId, before, actor, occurredAt, metadata),
    type: 'conversation.subject_set',
    payload: { source },
  };
}

/**
 * `conversation.assigned` — ONE type for assign / reassign / unassign, because they are three
 * readings of one fact. Three types would be three vocabularies free to drift.
 */
export function assigned(
  accountId: string,
  before: ConversationBefore,
  to: string | null,
  actor: TransitionActor,
  occurredAt: Date,
  metadata?: Metadata,
): RecordTransitionInput {
  return {
    ...base(accountId, before, actor, occurredAt, metadata),
    type: 'conversation.assigned',
    payload: { from: before.assignee_operator_id ?? null, to },
  };
}
