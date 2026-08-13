import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §3) — **the writer of `Operator.active`.**
 *
 * The flag has been READ since feature 018 — `OperatorRepository.resolveByAuthUserIds` filters on it,
 * and the assignable list and the participant resolver honour it — and until now nothing in the
 * product ever wrote it. Deactivation existed as a column and as nobody's capability.
 *
 * ── Why this is its own file in `maintenance/`, and not a method on `OperatorRepository` ──────────
 * `tests/users-read/no-outbound.spec.ts` (FR-027) scans the two read repositories and fails on any
 * write verb. That guard is not in the way here — it is **right**: it exists because a mutation
 * bolted onto the read API would arrive without a permission key, without an audit action and
 * without the abnormal-volume alert that a portfolio or assignment edit needs. A lifecycle flag
 * driven by a machine is a different animal with a different gate, so it belongs beside the other
 * system-actor writes this module already owns (the artefact purge), not beside the reads.
 * ⇒ The read repositories stay literally write-free, and the guard keeps meaning what it says.
 */
@Injectable()
export class StaffLifecycleRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * ⚠️ **`not_found` is a real outcome and the caller must refuse on it.** The tempting alternative —
   * answering `changed: false` for an unknown identity — makes «this person has no profile» look
   * exactly like «they were already inactive», so a mistyped id or the wrong account in the metadata
   * would report a successful offboarding while the person keeps taking work. That is SEC-PV2's own
   * shape, and it is what the sibling reads already refuse: `GetChannelEnvelope` answers NOT_FOUND
   * rather than an empty envelope for the same reason.
   *
   * ⚠️ Unknown and «another account's operator» are the SAME answer, because `findFirst` under
   * `forAccount` composes the account predicate into the query — there is no `row.account_id !==
   * caller` comparison here for a later edit to split into two different answers (Principle I).
   *
   * Reactivation is the same method with `active: true`: one writer, two directions, so «who can turn
   * a person back on» has one answer rather than a second path nobody audited.
   */
  async setActive(
    accountId: string,
    authUserId: string,
    active: boolean,
  ): Promise<{ outcome: 'changed' | 'unchanged' | 'not_found'; operatorId: string }> {
    if (!accountId || !authUserId) return { outcome: 'not_found', operatorId: '' };
    const db = this.prisma.forAccount(accountId);

    const row = (await db.operator.findFirst({
      where: { auth_user_id: authUserId },
      select: { id: true, active: true },
    })) as { id: string; active: boolean } | null;
    if (!row) return { outcome: 'not_found', operatorId: '' };

    // ⚠️ The operator id travels back with the verdict. The offboarding sweep has to name this person
    // to chats next, where an assignee is a `users.Operator.id` and NOT the auth user id it started
    // from; answering it here — from a row already read — is what stops the caller either asking a
    // second rpc or, far worse, passing the auth id on, where it would match no conversation and
    // report a clean «no open work» for somebody holding all of it.
    if (row.active === active) return { outcome: 'unchanged', operatorId: row.id };

    // The old value is in the predicate, so two racing calls cannot both report they made the change.
    // Whoever loses reports `unchanged`, which is true: the flag holds the value they asked for.
    const { count } = await db.operator.updateMany({
      where: { id: row.id, active: !active },
      data: { active },
    });
    return { outcome: count > 0 ? 'changed' : 'unchanged', operatorId: row.id };
  }
}
