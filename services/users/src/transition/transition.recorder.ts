import { Injectable } from '@nestjs/common';
import { buildTransitionRow, type TransitionRowInput } from '@crm/common';
import type { TransitionDims } from './transition.dims';

/**
 * Records one transition in `users_db` (feature 025, roadmap 5.9 — ADR 0046 / U7).
 *
 * ── This service is the SECOND writer of the stream, and the first outside `chats` ──────────────
 * U7's ownership rule is *each service writes the events of the aggregates it owns*, and it forbids
 * a shared cross-service table — which Principle VIII makes impossible anyway, since a shared table
 * is a cross-service join by another name. So this is a second TABLE.
 *
 * It is emphatically NOT a second ENVELOPE. `buildTransitionRow` in `@crm/common` shapes every row
 * in the product, and `tests/data-model/one-transition-envelope.spec.ts` compares the two tables
 * column for column. The downstream B2 aggregate store reads *one logical stream*; two shapes would
 * mean it must know both, permanently.
 *
 * ── The recorder takes a transaction; it never opens one ────────────────────────────────────────
 * Recording is ATOMIC with the change it describes (feature 023's FR-004, and it travels with the
 * writer). A rolled-back presence change must leave no record, and a record must always correspond
 * to something that really happened. That is only true if the insert rides the caller's transaction,
 * so this class cannot start one — and the type signature is what enforces it, not a convention.
 *
 * ── ⚠️ There is no dispatcher here, and there must not be ───────────────────────────────────────
 * `chats` has two things with confusable names: this durable history, and an in-process
 * `DomainEvent` used to trigger automations, which is deliberately lossy and legitimately carries
 * message text in memory. `users` has no dispatcher at all, and merging the two concepts is what
 * would land customer text in an append-only store —
 * `tests/transitions/no-dispatcher-crossover.spec.ts` keeps them apart on the chats side, and the
 * absence of any equivalent here is the users-side answer.
 */

/** The minimum surface this needs from a Prisma transaction client — never the whole client. */
export interface OperatorTransitionTx {
  operatorTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * The batch counterpart, mirroring chats. Validation happens at BUILD time, so an unknown type or a
 * rejected payload refuses the whole act before the batch is handed to Postgres, rather than landing
 * in the middle of it.
 */
export interface OperatorTransitionStatementClient {
  operatorTransition: {
    create(args: { data: Record<string, unknown> }): unknown;
  };
}

export interface RecordOperatorTransitionInput
  extends Omit<TransitionRowInput, 'subjectKind' | 'dims'> {
  /**
   * Always `operator` in this service — the KIND of subject, not the table it came from. `subjectId`
   * is the AUTH USER ID (research R3), the same identifier `actor_ref` carries everywhere in this
   * stream, and deliberately not the operator PROFILE id.
   */
  subjectKind: 'operator';
  dims: TransitionDims;
}

@Injectable()
export class OperatorTransitionRecorder {
  /** Write one transition inside the caller's transaction. */
  async record(tx: OperatorTransitionTx, input: RecordOperatorTransitionInput): Promise<void> {
    await tx.operatorTransition.create({ data: buildTransitionRow(input) });
  }

  /** Build the insert WITHOUT executing it, for a caller whose transaction is a batch. */
  buildStatement(
    db: OperatorTransitionStatementClient,
    input: RecordOperatorTransitionInput,
  ): unknown {
    return db.operatorTransition.create({ data: buildTransitionRow(input) });
  }
}
