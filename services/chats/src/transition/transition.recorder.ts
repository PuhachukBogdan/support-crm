import { Injectable } from '@nestjs/common';
import { buildTransitionRow, TransitionTypeError, type TransitionType } from '@crm/common';
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

/**
 * ⚠️ `TransitionTypeError` now lives in `@crm/common` and is RE-EXPORTED here.
 *
 * Feature 025 made `users` the second writer of this stream, so the row shaping moved to
 * `libs/common/src/transitions/row.ts` — see FR-004: two writers must produce structurally identical
 * rows, and "identical" written twice by hand is "identical until somebody edits one of them".
 *
 * The re-export is deliberate rather than lazy: several chats specs import this symbol from here,
 * and changing where they import an error class from is churn that proves nothing. What matters is
 * that there is one class, not two with the same name.
 */
export { TransitionTypeError };

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

  /**
   * The one place a transition row is shaped, so the two entry points cannot drift apart.
   *
   * ── Feature 025: the shaping now lives in `@crm/common` ─────────────────────────────────────
   * It used to be implemented here, and moving it is the whole of what feature 025 changed in this
   * file. `users` became the second writer of this stream, and the B2 aggregate store downstream
   * reads *one logical stream* — which is only achievable if both writers emit the same envelope.
   * Sharing the function is how that stops being a promise (FR-004).
   *
   * The three refusals travelled with it verbatim: an unknown type, a payload the allow-list rejects,
   * and a system actor that does not name itself. They still throw BEFORE the insert and still ride
   * the caller's transaction, so a transition we cannot describe correctly still rolls the whole act
   * back.
   *
   * What deliberately did NOT move: this class. The atomicity rule is expressed in the type
   * signatures below — the recorder takes a transaction and cannot open one — and those signatures
   * are service-specific because the Prisma delegate is.
   */
  private toRow(input: RecordTransitionInput): Record<string, unknown> {
    return buildTransitionRow(input);
  }
}
