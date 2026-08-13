import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { AuthStaffClient } from '../auth/auth.client';
import { UsersMaintenanceClient } from '../users/users.client';
import { ChatsMaintenanceClient } from '../chats/chats.client';

export const STAFF_OFFBOARDING_QUEUE = 'crm-staff-offboarding';
export const STAFF_OFFBOARDING_JOB = 'sweep-offboarded-staff';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §3/§4, SEC-PV2) — **finishing an offboarding.**
 *
 * ── The failure this exists to prevent ──────────────────────────────────────────────────────────
 * Closing an account is only one third of letting somebody go. The account lives in `auth`, the
 * routing flag lives in `users`, and the open conversations live in `chats`. Close only the first and
 * the result is the failure that looks like nothing: the person cannot log in, they vanish from every
 * routing pool, and the tickets already assigned to them stay assigned to them. No error, no alert,
 * and a customer waiting on somebody who left. That is SEC-PV2 in one sentence.
 *
 * ── ⚠️ Why a TICK, when the HR platform is right there holding the connection ────────────────────
 * The first draft did all three inside the `DELETE` request, with the gateway calling auth and then
 * chats. Two independent things killed it, and both are worth keeping written down:
 *
 * 1. **`tests/worker/maintenance-ticks.spec.ts` refuses to let the gateway name a maintenance rpc** —
 *    *«only a tick may call it; if HTTP can ask, the system-actor check is decoration»*. The guard
 *    was right on its own terms, and it was also right about this specific code: the draft was
 *    passing an **auth user id** where chats expects a `users.Operator.id`. Those two id spaces look
 *    alike and the wrong one matches no conversation — so it would have reported a clean handover,
 *    every time, while moving nothing. The most dangerous possible bug in this feature, caught by a
 *    structural guard before it ran once.
 * 2. **It would have made the guarantee somebody else's.** In-request, «the account closed but the
 *    work did not move» can only be reported back to the HR platform and retried by it — a system we
 *    neither control, test, nor can inspect. As a tick it is retried by our own infrastructure until
 *    it succeeds, which is what SEC-PV2 actually asks for.
 *
 * ── What it costs, stated plainly ───────────────────────────────────────────────────────────────
 * The work moves within a tick rather than within the response. For the interval below that is a
 * minute of a conversation sitting with somebody who has just left — against a permanent orphan in
 * the failure case of the alternative.
 *
 * ── Idempotent by predicate, so no queue and no «handled» flag ───────────────────────────────────
 * Both follow-up calls are no-ops when there is nothing to do: setting an inactive operator inactive
 * answers `unchanged`, and returning already-moved work answers `moved: 0`. So the sweep re-reads the
 * same recently-disabled people every tick and writes nothing — which is why this needed no second
 * table. A «handled» flag would be one more thing to keep true, and the first failed run makes it lie.
 *
 * ── The reach it gained for free ────────────────────────────────────────────────────────────────
 * It sweeps on `User.status = disabled`, not on «the HR platform called us». Any future path that
 * closes an account — an administrator in Access Management, a migration, an incident response — gets
 * the same handover without knowing this exists. That is the difference between a feature and an
 * invariant.
 */
@Injectable()
export class StaffOffboardingJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaffOffboardingJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuthStaffClient) private readonly auth: AuthStaffClient,
    @Inject(UsersMaintenanceClient) private readonly users: UsersMaintenanceClient,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
  ) {}

  /**
   * 🅿 PROVISIONAL. A minute is the lag between a colleague being let go and their queue being freed,
   * and the sweep's steady state is «read a handful of rows, write nothing» — so this is paced for
   * the exceptional case rather than the common one. Revised by ops with the other intervals.
   */
  private get intervalMs(): number {
    return clampInt(process.env.STAFF_OFFBOARDING_INTERVAL_MS, 60_000, 10_000, 3_600_000);
  }
  /** How many recently-disabled people one pass re-checks. */
  private get batch(): number {
    return clampInt(process.env.STAFF_OFFBOARDING_BATCH, 50, 1, 200);
  }
  /**
   * How far back «recently» reaches. This is what bounds the sweep — not a flag saying the work is
   * done. Somebody disabled longer ago than this has been swept thousands of times already.
   */
  private get windowDays(): number {
    return clampInt(process.env.STAFF_OFFBOARDING_WINDOW_DAYS, 30, 1, 365);
  }
  /** Conversations moved per person per pass; the rest follow on the next tick. */
  private get handoverBatch(): number {
    return clampInt(process.env.STAFF_HANDOVER_BATCH, 50, 1, 100);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(STAFF_OFFBOARDING_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(STAFF_OFFBOARDING_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time: two overlapping passes would read the same people and race on the same
      // conversations, and every loser's write is a no-op — noise rather than progress.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // ⚠️ The one warning anybody gets. A stopped offboarding sweep is invisible from outside: no
      // error surfaces anywhere, and departed colleagues simply keep holding live conversations.
      this.logger.warn(`staff offboarding sweep failed: ${err?.name ?? 'error'}: ${firstLine(err?.message)}`);
    });

    await this.queue.add(
      STAFF_OFFBOARDING_JOB,
      {},
      { repeat: { every: this.intervalMs }, removeOnComplete: true, removeOnFail: 100 },
    );
    this.logger.log(
      `staff offboarding sweep scheduled every ${this.intervalMs}ms (batch ${this.batch}, window ${this.windowDays}d)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const staff = await this.auth.listDisabledStaff(this.batch, this.windowDays);
    if (staff.length === 0) return;

    let movedToLead = 0;
    let movedToBacklog = 0;
    let noDesk = 0;
    let remaining = 0;
    let portfolioMoved = 0;
    let portfolioAwaiting = 0;
    let failed = 0;

    /**
     * ⭐ W32 — one desk-lead lookup per ACCOUNT, not per person.
     *
     * Several people from one account routinely leave in the same pass (a team is let go, a contract
     * ends), and the desks do not change between them. Caching it here also keeps the answer CONSISTENT
     * within a pass: two colleagues from one desk cannot end up with different successors because an
     * administrator renamed a lead halfway through.
     */
    const leadsByAccount = new Map<string, Map<string, string>>();
    const resolveDeskLeads = async (accountId: string): Promise<Map<string, string>> => {
      const cached = leadsByAccount.get(accountId);
      if (cached) return cached;
      const desks = await this.auth.listDeskLeads(accountId);
      // ⚠️ THE ONE TRANSLATION. Desk leads arrive as AUTH user ids; a conversation is assigned by
      // `users.Operator.id`. Doing it here, once, is the whole reason those two id spaces never meet
      // by accident — W31's first draft let them, and would have reported a clean handover while
      // moving nothing, for ever. `resolveOperatorIds` also drops anybody without an ACTIVE profile,
      // so a lead who has themselves left is disqualified with no second rule to forget.
      const operatorOf = await this.users.resolveOperatorIds(
        accountId,
        desks.map((d) => d.leadUserId),
      );
      const byDesk = new Map<string, string>();
      for (const desk of desks) {
        const operatorId = operatorOf.get(desk.leadUserId);
        if (operatorId) byDesk.set(desk.groupId, operatorId);
      }
      leadsByAccount.set(accountId, byDesk);
      return byDesk;
    };

    for (const person of staff) {
      try {
        // 1. Out of every routing pool. `null` means users holds no operator row for them — plenty of
        //    accounts belong to people who never took a conversation, so it is an ordinary answer and
        //    there is nothing further to do for them.
        const operator = await this.users.setOperatorActive(person.accountId, person.userId, false);
        if (!operator || operator.operatorId === '') continue;

        // 2. Where each desk's work should go instead of the queue. An empty map is not a failure —
        //    it reproduces exactly what W31 did, which is the safety net rather than a degraded path.
        const deskLeads = await resolveDeskLeads(person.accountId);
        const deskDestinations = [...deskLeads]
          // ⚠️ Somebody who leads their own desk cannot be their own successor: handing the work back
          //    to the person who just left is a no-op that reads as success in every count.
          .filter(([, toOperatorId]) => toOperatorId !== operator.operatorId)
          .map(([groupId, toOperatorId]) => ({ groupId, operatorId: toOperatorId }));

        // 3. Their open work — to a named person where a desk has one, to the queue otherwise. The id
        //    here is users' answer, NOT `person.userId` — see the client method's own warning.
        const counts = await this.chats.returnOperatorWorkToBacklog(
          person.accountId,
          operator.operatorId,
          this.handoverBatch,
          deskDestinations,
        );
        movedToLead += counts.movedToLead;
        movedToBacklog += counts.movedToBacklog;
        noDesk += counts.noDesk;
        remaining += counts.remaining;

        // 4. And the PORTFOLIO — the players who were personally theirs.
        //
        // ⚠️ **Only when their desks agree on ONE successor**, and the ambiguity is reported rather
        // than resolved. An attachment grants access to a real customer's data: sending it to a
        // manager nobody chose is worse than leaving a stale attachment that an administrator can see
        // and fix. Several desks that name the SAME person are not ambiguity, so they move.
        const distinctLeads = new Set(deskDestinations.map((d) => d.operatorId));
        const portfolioDestination = await this.portfolioSuccessor(distinctLeads);
        if (portfolioDestination) {
          const portfolio = await this.users.reassignPortfolio(
            person.accountId,
            person.userId,
            portfolioDestination,
            this.handoverBatch,
          );
          portfolioMoved += portfolio.moved;
        } else {
          portfolioAwaiting += 1;
        }
      } catch (e) {
        // ⚠️ One person's failure must not end the pass. Whoever is left is picked up by the next
        // tick — that is the property this design was chosen for — and stopping here would let a
        // single misconfigured account block every other offboarding indefinitely.
        //
        // ⚠️ **The NAME only, never the message.** Every other tick in this service may quote an
        // error text safely because it sends a limit and receives counts — there are no identifiers
        // in the exchange to echo. This one is the exception: its requests carry an account id, an
        // auth user id and an operator id, so a single-line driver error («invalid input syntax for
        // type uuid: "oper-…"») would print one straight into the log. The class is what an operator
        // acts on anyway; the detail belongs to whoever reads the failing service's own logs.
        failed += 1;
        this.logger.warn(`offboarding step failed: ${(e as Error)?.name ?? 'error'}`);
      }
    }

    // ⚠️ Counts only, and silent on a quiet pass. Nothing identifying crosses this boundary, so
    // nothing identifying can be logged — and a line every minute saying «0 moved» would bury the one
    // line that matters. `noDesk` is the one an administrator must act on: those conversations are
    // still assigned to somebody who has left, because we could not work out where to send them.
    if (movedToLead || movedToBacklog || noDesk || portfolioMoved || portfolioAwaiting || failed) {
      this.logger.log(
        `staff offboarding: toLead=${movedToLead} toBacklog=${movedToBacklog} noDesk=${noDesk} ` +
          `portfolio=${portfolioMoved} awaitingOwner=${portfolioAwaiting} ` +
          `remaining=${remaining} failed=${failed}`,
      );
    }
  }

  /**
   * ⭐ W32 — who receives the departing person's PORTFOLIO, or nobody.
   *
   * The portfolio belongs to no desk, so the conversation's own answer («the lead of the desk it is
   * on») does not apply. It is resolved from the desks the person BELONGED to — and when those name
   * more than one eligible successor, this returns `null` and the attachments stay where they are.
   *
   * ⚠️ Refusing is the feature here, not a gap. An attachment grants access to a customer's portfolio,
   * preferences and notes; guessing a destination to avoid an empty report is exactly how a real
   * person's data reaches a manager nobody chose. The count surfaces on the security page so the
   * decision reaches a human instead of being made for them.
   *
   * ⓘ Today the person's own desks are not directly readable from the worker, so the candidate set is
   * the account's eligible leads. With one lead in the account the answer is unambiguous; with several
   * it is deliberately not, and a human decides. Narrowing it to the person's OWN desks is the obvious
   * next improvement and needs a membership read this job does not yet make.
   */
  private async portfolioSuccessor(distinctLeads: Set<string>): Promise<string | null> {
    if (distinctLeads.size !== 1) return null;
    return [...distinctLeads][0] ?? null;
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

const firstLine = (m?: string): string => (m ?? '').split('\n')[0]!.slice(0, 200);
