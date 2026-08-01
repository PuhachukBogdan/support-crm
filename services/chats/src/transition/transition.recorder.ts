import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { assertTransitionPayload, isTransitionType, type TransitionType } from '@crm/common';
import type { TransitionDims } from './transition.dims';

/**
 * Records one transition (feature 023, roadmap 4.8a — ADR 0046).
 *
 * ── ⚠️ THIS IS NOT `DomainEventDispatcher` AND MUST NEVER TOUCH IT ───────────────────────────────
 * `src/events/` holds an in-process automation trigger: synchronous, deliberately LOSSY, and it
 * legitimately carries message text in memory. This is durable history with ids and enums only.
 * `tests/transitions/no-dispatcher-crossover.spec.ts` fails the build if the two ever import each
 * other, because merging them would put customer message bodies into an append-only store.
 *
 * Note the mirror-image placement, which is not an accident: the dispatcher may be published ONLY
 * from controllers (feature 014's no-cascade guard), and this recorder is called ONLY from inside a
 * repository transaction. Two rules that look contradictory, protecting two different things.
 *
 * ── The recorder takes a transaction; it never opens one ─────────────────────────────────────────
 * FR-004: recording is ATOMIC with the change it describes. A rolled-back change must leave nothing,
 * and a recorded transition must always correspond to something that really happened. That is only
 * true if the insert rides the caller's transaction — so this class cannot start one, and the type
 * signature is what enforces it.
 *
 * FR-005 (delivery is best-effort) has no code here on purpose: there is no consumer yet. What must
 * hold today is that nothing on the customer-facing path blocks on one — so this file performs no
 * network call, publishes to no queue, and awaits nothing but its own insert.
 */

/** The minimum surface this needs from a Prisma transaction client — never the whole client. */
export interface TransitionTx {
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * ── Why there are TWO ways to record, and why that is not duplication ────────────────────────────
 *
 * This service already has two transaction shapes and they are both deliberate:
 *
 *   • **interactive** — `db.$transaction(async (tx) => …)`, used by the message write (feature 022),
 *     where later statements depend on earlier results (the stamp uses the created row's own id).
 *   • **batch** — `db.$transaction([stmt, stmt, …])`, used by macros (013) and automations (014),
 *     where the guarantee is *all-or-nothing by ORDERING*: every check happens BEFORE the batch, so a
 *     refused action writes zero rows. That design was proven live 68/68 and must not be rewritten to
 *     get a transition into it.
 *
 * So the recorder offers both: `record(tx, …)` executes inside an interactive transaction, and
 * `buildStatement(db, …)` returns an UNEXECUTED statement the caller appends to its own batch.
 * Validation runs in `buildStatement` too — at build time, before the batch is handed to Postgres —
 * so an unknown type or a rejected payload still refuses the whole act rather than landing in it.
 */
export interface TransitionStatementClient {
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): unknown;
  };
}

export interface RecordTransitionInput {
  accountId: string;
  type: TransitionType | string;
  /** When it HAPPENED. Pass the created row's own timestamp where there is one (the 022 rule). */
  occurredAt: Date;
  actorKind: 'user' | 'system' | 'integration';
  /** A user id, or the rule/job that acted. Never blank for a system act. */
  actorRef?: string | null;
  subjectKind: 'conversation' | 'escalation' | 'operator' | 'staff';
  subjectId: string;
  payload?: Record<string, unknown>;
  dims: TransitionDims;
  /** Ties this to the audit entry produced by the same act. Generated per act, not per record. */
  correlationId: string;
}

export class TransitionTypeError extends Error {
  constructor(type: unknown) {
    // The type is a catalogue literal when valid; when invalid it is caller input, so it is described
    // rather than echoed (the feature 021 lesson — an unknown key reflected into a log).
    super(
      typeof type === 'string'
        ? `unknown transition type: <${type.length} chars>`
        : `unknown transition type: <${typeof type}>`,
    );
    this.name = 'TransitionTypeError';
  }
}

@Injectable()
export class TransitionRecorder {
  /**
   * Write one transition inside the caller's transaction.
   *
   * Refuses BEFORE the insert: an unknown type or a payload the allow-list rejects throws, and
   * because this runs inside the caller's transaction that refusal rolls the whole act back. That is
   * intentional — a state change we cannot describe correctly is worse than a refused one, and the
   * failure surfaces in development where the catalogue entry is missing, not in production.
   */
  async record(tx: TransitionTx, input: RecordTransitionInput): Promise<void> {
    await tx.conversationTransition.create({ data: this.toRow(input) });
  }

  /**
   * Build the insert WITHOUT executing it, for callers whose transaction is a batch (macros 013,
   * automations 014). Validation happens here, so a bad transition refuses the whole act at build
   * time — the batch is never even handed to Postgres.
   */
  buildStatement(db: TransitionStatementClient, input: RecordTransitionInput): unknown {
    return db.conversationTransition.create({ data: this.toRow(input) });
  }

  /** The one place a transition row is shaped, so the two entry points cannot drift apart. */
  private toRow(input: RecordTransitionInput): Record<string, unknown> {
    if (!isTransitionType(input.type)) throw new TransitionTypeError(input.type);
    assertTransitionPayload(input.type, input.payload);

    if (input.actorKind === 'system' && !input.actorRef) {
      // A timer or a rule names itself. "Something happened, by nobody" is the entry that makes a
      // trail useless six months later.
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
}
