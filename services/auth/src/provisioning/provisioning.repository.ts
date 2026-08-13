import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §6/§7): the two stores the machine path needs — the
 * idempotency ledger and the HR↔user mapping — plus the account-lifecycle write.
 *
 * ⚠️ **The ledger is claimed INSERT-FIRST**, never select-then-insert. Two retries of the same
 * webhook arrive in the same second by design (that is what a retry IS), and a read-then-write would
 * let both pass the read before either wrote. The unique index decides; the loser reads the winner's
 * stored answer and returns it. Exactly the channel-intake ledger's shape, with the two things ADR
 * 0043 §6 additionally requires: the stored RESPONSE and the body digest that makes «same key,
 * different body» a conflict rather than a silent overwrite.
 */

export interface ClaimInput {
  accountId: string;
  apiKeyId: string;
  idempotencyKey: string;
  operation: 'create' | 'deactivate';
  bodyHash: string;
}

export type ClaimResult =
  | { kind: 'claimed'; id: string }
  /** Someone got there first with the SAME body — replay their answer, do nothing else. */
  | { kind: 'replay'; statusCode: number; bodyJson: string; outcome: string }
  /** Same key, DIFFERENT body — the caller reused an idempotency key for a new intent (409). */
  | { kind: 'conflict' };

const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === 'P2002';

@Injectable()
export class ProvisioningRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Claim the idempotency key, or discover what the first caller already answered.
   *
   * The row is written with a placeholder answer and completed by `settle()` once the work is done:
   * a claim that recorded the answer up-front would be lying about work that had not happened yet,
   * and a claim taken after the work would not be a claim at all.
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      const row = await this.prisma.provisioningRequest.create({
        data: {
          account_id: input.accountId,
          api_key_id: input.apiKeyId,
          idempotency_key: input.idempotencyKey,
          operation: input.operation,
          body_hash: input.bodyHash,
          status_code: 0,
          response_json: {},
          outcome: 'in_flight',
        },
      });
      return { kind: 'claimed', id: row.id };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const first = await this.prisma.provisioningRequest.findFirst({
        where: { api_key_id: input.apiKeyId, idempotency_key: input.idempotencyKey },
      });
      // Vanished between the collision and the read — treat as a conflict rather than inventing a
      // second attempt: we know something else owned this key and we no longer know what it said.
      if (!first) return { kind: 'conflict' };
      if (first.body_hash !== input.bodyHash) return { kind: 'conflict' };
      // ⚠️ A concurrent first call may still be in flight. Replaying `in_flight` would answer «done»
      // for work that has not finished, so it is a conflict for the caller to retry — the honest
      // shape of «ask me again in a moment».
      if (first.outcome === 'in_flight') return { kind: 'conflict' };
      return {
        kind: 'replay',
        statusCode: first.status_code,
        bodyJson: JSON.stringify(first.response_json ?? {}),
        outcome: first.outcome,
      };
    }
  }

  /** Record what the claimed call actually answered, so a later retry replays it verbatim. */
  async settle(id: string, statusCode: number, bodyJson: string, outcome: string): Promise<void> {
    await this.prisma.provisioningRequest.update({
      where: { id },
      data: { status_code: statusCode, response_json: JSON.parse(bodyJson), outcome },
    });
  }

  /**
   * Accepted AND refused calls for this key in the trailing hour.
   *
   * ⚠️ Durable, counted from rows that exist for other reasons — an in-memory counter resets on
   * deploy, and a security cap that resets is not a cap (the export-quota reasoning). Refusals count
   * too: a cap that only counted successes would let a brute-force run for ever.
   */
  async countRecentCalls(apiKeyId: string, since: Date): Promise<number> {
    return this.prisma.provisioningRequest.count({
      where: { api_key_id: apiKeyId, created_at: { gte: since } },
    });
  }

  // ── the HR ↔ user mapping (ADR 0043 §7) ────────────────────────────────────────────────────────

  async userIdForEmployee(accountId: string, hrEmployeeId: string): Promise<string | null> {
    const row = await this.prisma.staffIdentity.findFirst({
      where: { account_id: accountId, hr_employee_id: hrEmployeeId },
    });
    return row?.user_id ?? null;
  }

  /**
   * Bind an HR id to a user. Idempotent: re-binding the same pair is a no-op, not a duplicate.
   *
   * ⚠️ **`StaffIdentity` has TWO unique constraints and this has to satisfy both** — `(account,
   * hr_employee_id)` says one person per employee number, and `(account, user_id)` says one employee
   * number per person. An upsert keyed on the first alone crashed on the second the moment HR sent a
   * NEW employee id for somebody we already knew: it found no row for the new id, tried to create
   * one, and hit the per-user constraint. The caller got a 500, and — worse — the binding never
   * happened, so the later `DELETE /staff/{new id}` answered «unknown employee» and the offboarding
   * silently did nothing. Found on the W31 live round's second pass (the first pass could not see it:
   * the person had no previous binding yet).
   *
   * ⚠️ **The NEWEST id wins, and that is a decision rather than a convenience.** A re-hire is exactly
   * the case where HR issues a new employee number for the same human, and ADR 0043 §7's rule is
   * «never two accounts for one person» — so the binding follows the PERSON. The old number stops
   * resolving, which is correct: that employment instance is over, and a termination event quoting it
   * should not be able to close the new one.
   */
  async bindEmployee(accountId: string, hrEmployeeId: string, userId: string): Promise<void> {
    // One statement, so a crash between «drop the old» and «write the new» cannot leave a person with
    // no binding at all — which would make them unreachable by any future HR event.
    await this.prisma.$transaction([
      this.prisma.staffIdentity.deleteMany({
        where: { account_id: accountId, user_id: userId, hr_employee_id: { not: hrEmployeeId } },
      }),
      this.prisma.staffIdentity.upsert({
        where: { account_id_hr_employee_id: { account_id: accountId, hr_employee_id: hrEmployeeId } },
        create: { account_id: accountId, hr_employee_id: hrEmployeeId, user_id: userId },
        update: { user_id: userId },
      }),
    ]);
  }

  /**
   * Staff whose account is closed, most recently first, inside a window.
   *
   * ⚠️ **Deliberately NOT scoped to one account** — this is the machine surface, and the sweep that
   * asks belongs to no tenant. Every row carries its own `account_id` so the caller can pass it on;
   * that is the same shape `ResolveRoutingOperators` uses, and the reason the scoped-client rule has
   * an explicit exception for machine reads rather than a quiet bypass here (Principle I).
   */
  async listDisabledStaff(since: Date, limit: number): Promise<{ accountId: string; userId: string }[]> {
    const rows = await this.prisma.user.findMany({
      where: { status: 'disabled', updated_at: { gte: since } },
      orderBy: { updated_at: 'desc' },
      take: limit,
      select: { id: true, account_id: true },
    });
    return rows.map((r) => ({ accountId: r.account_id, userId: r.id }));
  }

  // ── the account lifecycle (ADR 0043 §3) ────────────────────────────────────────────────────────

  async findUserByEmail(accountId: string, email: string) {
    return this.prisma.user.findFirst({ where: { account_id: accountId, email } });
  }

  async findUserById(accountId: string, userId: string) {
    return this.prisma.user.findFirst({ where: { account_id: accountId, id: userId } });
  }

  /** Every role key this user holds — the administrator bar reads it before touching anybody. */
  async roleKeysOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    return rows.map((r) => (r as { role?: { key?: string } }).role?.key ?? '').filter(Boolean);
  }

  /**
   * Close the account: status `disabled` and every role binding removed.
   *
   * ⚠️ The ROLES GO, the record STAYS (ADR 0043 §3). Dropping the bindings is what makes the account
   * inert even if some future path forgets to check `status`; keeping the row is what preserves
   * message authorship, the audit trail and the numbers — the reason «delete» from an external
   * system is a deactivation here and never an erasure.
   */
  async deactivateUser(accountId: string, userId: string): Promise<boolean> {
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: userId, account_id: accountId, status: { not: 'disabled' } },
        data: { status: 'disabled' },
      }),
      this.prisma.userRole.deleteMany({ where: { user_id: userId } }),
    ]);
    return (updated as { count: number }).count > 0;
  }
}
