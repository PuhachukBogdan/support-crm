import { randomUUID } from 'node:crypto';
import { isTransitionType, type TransitionSubject, type TransitionType } from './catalogue';
import { assertTransitionPayload } from './payload';

/**
 * The ONE place a durable transition row is shaped (feature 025, roadmap 5.9 — FR-004).
 *
 * ── Why this is here and not in a service ───────────────────────────────────────────────────────
 * Until feature 025 there was exactly one writer of the transition stream (`chats`), and the row
 * shaping lived inside its recorder. Presence made `users` the SECOND writer and the first outside
 * chats. U7 forbids a shared cross-service table — that would be a cross-service join by another
 * name — so each service owns its own table.
 *
 * But the downstream B2 aggregate store reads **one logical stream**. That is only achievable if the
 * two writers produce structurally identical rows, and "identical" written twice by hand is
 * "identical until somebody edits one of them". So the *shaping* is shared even though the *storage*
 * cannot be, and FR-004 becomes true by construction rather than by discipline.
 *
 * ── What did NOT move, and why ──────────────────────────────────────────────────────────────────
 * Only this pure function. The `@Injectable()` recorders stay in their services, each over its own
 * Prisma delegate, because:
 *   • `libs/common` is deliberately pure data + helpers — putting an I/O-performing class in the one
 *     library both sides import would make every future writer inherit a dependency on Nest;
 *   • the ATOMICITY rule is expressed in each recorder's type signature (it takes the caller's
 *     transaction and cannot open one), and that signature is service-specific because the delegate
 *     is.
 *
 * ── The three refusals, moved verbatim ──────────────────────────────────────────────────────────
 * An unknown type, a payload the allow-list rejects, and a system actor that does not name itself
 * all throw HERE — before the insert, inside the caller's transaction, so the whole act rolls back.
 * That is intentional: a state change we cannot describe correctly is worse than a refused one, and
 * the failure surfaces in development where the catalogue entry is missing, not in production.
 *
 * Pure. No I/O.
 */

export class TransitionTypeError extends Error {
  constructor(type: unknown) {
    // The type is a catalogue literal when valid; when invalid it is CALLER INPUT, so it is
    // described rather than echoed — the feature 021 lesson about an unknown key reflected into a log.
    super(
      typeof type === 'string'
        ? `unknown transition type: <${type.length} chars>`
        : `unknown transition type: <${typeof type}>`,
    );
    this.name = 'TransitionTypeError';
  }
}

export interface TransitionRowInput {
  accountId: string;
  type: TransitionType | string;
  /** When it HAPPENED. Pass the created row's own timestamp where there is one (the 022 rule). */
  occurredAt: Date;
  actorKind: 'user' | 'system' | 'integration';
  /** A user id, or the rule/job that acted. Never blank for a system act. */
  actorRef?: string | null;
  subjectKind: TransitionSubject;
  subjectId: string;
  payload?: Record<string, unknown>;
  /**
   * The reporting dimensions AS THEY WERE. Absent members are omitted, never nulled.
   *
   * Typed as `object` rather than `Record<string, unknown>` on purpose: each service declares its
   * own `TransitionDims` **interface** (conversations carry brand/channel/assignee; operators carry
   * channel/submitterRole), and a TypeScript interface has no implicit index signature, so it is not
   * assignable to a `Record`. Widening the parameter here is the honest fix — the alternative is a
   * cast at each of the two call sites, which is the same looseness written twice and further from
   * the reason for it.
   */
  dims: object;
  /** Ties this to the audit entry produced by the same act. Generated per act, not per record. */
  correlationId: string;
}

/** Validate and shape. The caller inserts it; this function never touches a database. */
export function buildTransitionRow(input: TransitionRowInput): Record<string, unknown> {
  if (!isTransitionType(input.type)) throw new TransitionTypeError(input.type);
  assertTransitionPayload(input.type, input.payload);

  if (input.actorKind === 'system' && !input.actorRef) {
    // A timer, a sweep or a rule names itself. "Something happened, by nobody" is the entry that
    // makes a trail useless six months later.
    throw new Error(`transition ${input.type}: a system actor must name itself`);
  }

  return {
    id: randomUUID(),
    account_id: input.accountId,
    type: input.type,
    occurred_at: input.occurredAt,
    actor_kind: input.actorKind,
    actor_ref: input.actorRef ?? null,
    subject_kind: input.subjectKind,
    subject_id: input.subjectId,
    payload_json: input.payload ?? null,
    dims_json: input.dims,
    correlation_id: input.correlationId,
  };
}
