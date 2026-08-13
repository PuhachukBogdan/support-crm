import { Inject, Injectable } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { PrismaService } from '../prisma.service';
import { type HeldConversation, unitsUsed } from './capacity';
import { AuthorAuthorityClient } from '../auth/auth.client';
import { PersonMembersClient } from '../person/person-members.client';
import { isAvailableFor } from '@crm/common';
import type { RoundRobinCandidate } from './round-robin';

/**
 * Build the auto-assignment candidate pool from a GROUP (feature 024, roadmap 5.3 — ADR 0039 §5.3).
 *
 * This is the source `AutoAssignConversation` has been waiting for since feature 013, whose handler
 * says so in as many words: *"the candidate set is supplied by the caller until the Users service can
 * resolve teams and capacity (roadmap 5.3)"*, and answers `GROUP_ROUTING_NOT_AVAILABLE` rather than
 * guessing. The placeholder was right; this replaces it without changing what it guaranteed.
 *
 * ── Three sources, and why each is where it is ──────────────────────────────────────────────────
 *  • **membership → auth.** Auth owns the group (the permission resolver reads it from the same
 *    database), so chats asks.
 *  • **auth identity → operator profile → users.** Membership keys on the auth user; a conversation's
 *    assignee is an operator profile. The translation is explicit rather than assumed — and
 *    `Conversation.assignee_operator_id` is deliberately NOT reinterpreted to avoid it (research R3).
 *  • **current load → HERE.** Chats owns the conversations, so it counts them itself instead of
 *    trusting a number from the caller. This is the one input nobody else can compute correctly.
 *
 * Two gRPC hops on this path is a deliberate trade, already made and documented in this service for
 * the same reason: auto-assignment is event-driven, not a keystroke path, so the extra hop is not on
 * a latency budget (Principle VII — see the header of `auth/auth.client.ts`).
 *
 * ── Fail-closed, and what "empty" is allowed to mean ────────────────────────────────────────────
 * Both clients RAISE when they cannot establish an answer, and neither returns an empty list in that
 * case. That distinction is the whole safety property here: an empty pool must mean *"this desk has
 * nobody available"* — a fact the caller reports honestly — and never *"I could not find out"*, which
 * would silently stop routing for a whole team while every request still answered 200.
 */

/**
 * 🅿 **PROVISIONAL.** How many open conversations one operator may hold before auto-assignment skips
 * them. There is no authoritative source for capacity yet: presence (5.9) does not exist and ADR
 * 0042's per-channel budgets are roadmap 4.19–4.21. **Revised by** both. It applies ONLY to the group
 * path — a caller supplying its own candidate list supplies its own capacities, exactly as before.
 */
export const ROUTING_DEFAULT_CAPACITY_ENV = 'ROUTING_DEFAULT_CAPACITY';

/**
 * ⭐ Feature 031: a desk that is not fed by automatic distribution.
 *
 * ⚠️ **Distinct from `GROUP_ROUTING_NOT_AVAILABLE`**, which means *"the pool could not be resolved"*.
 * Conflating *"this desk is not a queue"* with *"this desk's staffing is unknown"* would send an
 * administrator to look at rotas when the answer is a checkbox — the same reason feature 010 kept its
 * onboarding refusals apart.
 */
export const DESK_NOT_ROUTABLE = 'DESK_NOT_ROUTABLE';

/** What the pool answers: the candidates, and why there are none when there are none. */
export interface PoolOutcome {
  candidates: RoundRobinCandidate[];
  /** `null` when the pool was resolved normally — even if it resolved to nobody. */
  reason: string | null;
}

/** Statuses that count against an operator's load: work that is still theirs to finish. */
const OPEN_STATUSES = ['open', 'pending'] as const;

/**
 * ⭐ Feature 031 (roadmap 4.21, ADR 0042 §3) — the unit budget, **per brand**, with the deployment-wide
 * number as the fallback.
 *
 * ⚠️ **Per ROLE is deliberately absent, and it is blocked on the same thing routability was.** ADR 0042 §3
 * asks for a budget per role × brand. The candidate pool does not know anybody's role — neither
 * `ListGroupMembers` nor `ListOperatorsByAuthUsers` carries one, which is exactly why routability became a
 * property of the **desk** (option C, research R12). A per-role budget has the identical blocker.
 *
 * ⇒ Per BRAND ships now, because the conversation carries `brand_id` and the answer is available. Per-role
 * is recorded as **deferred**, and the natural substitute is a budget per **desk** — expressible today, and
 * arguably the truer model for the same reason C is: capacity is a property of the queue, not of a job title.
 *
 * ⚠️ `ROUTING_DEFAULT_CAPACITY` is kept as the fallback rather than replaced. Replacing it would make every
 * existing deployment's budget vanish on upgrade, and **two sources for one number is the same defect as two
 * gates** — so there is exactly one resolution order, stated here: brand override, then the deployment
 * default.
 *
 * Format: `ROUTING_CAPACITY_BY_BRAND=brand-a:4,brand-b:2`. An unparseable entry is IGNORED rather than
 * fatal: a typo in one brand's budget must not stop routing for every other brand, and the fallback is a
 * safe number by construction.
 */
export const ROUTING_CAPACITY_BY_BRAND_ENV = 'ROUTING_CAPACITY_BY_BRAND';

export function capacityForBrand(
  brandId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fallback = defaultCapacity(env);
  const raw = (env[ROUTING_CAPACITY_BY_BRAND_ENV] ?? '').trim();
  const key = (brandId ?? '').trim();
  if (!raw || !key) return fallback;

  for (const entry of raw.split(',')) {
    const [brand, value] = entry.split(':');
    if ((brand ?? '').trim() !== key) continue;
    const n = Number((value ?? '').trim());
    // A positive integer or nothing. Zero would mean "this brand receives no pushed work", which is a
    // routability decision and belongs on the desk, not hidden in a capacity number.
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return fallback;
}

export function defaultCapacity(env: NodeJS.ProcessEnv = process.env): number {
  // Validated at boot by the refuse-to-start config guard (SEC-6), so this cannot silently fall back
  // to a made-up number in production. The floor is here for the one caller that is not the service:
  // a test constructing the class directly.
  const raw = Number(env[ROUTING_DEFAULT_CAPACITY_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
}

@Injectable()
export class GroupPoolService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthorAuthorityClient) private readonly auth: AuthorAuthorityClient,
    @Inject(PersonMembersClient) private readonly users: PersonMembersClient,
  ) {}

  /**
   * The group's members as routing candidates, in a stable order.
   *
   * @returns an empty array when the group has nobody assignable — the caller turns that into
   *          `GROUP_ROUTING_NOT_AVAILABLE`.
   * @throws whatever the clients throw when the answer cannot be established (never an empty pool).
   */
  async candidatesFor(
    accountId: string,
    groupId: string,
    metadata: Metadata,
    channel: string | null = null,
    /**
     * ⚠️ **Required, deliberately** (FR-024). The budget is per brand, so the brand is an input to the
     * decision rather than an optional refinement — and making it required is what makes the compiler
     * enumerate every call site. Feature 026 proved the alternative: an optional parameter enumerates
     * nothing, and the one caller that forgot it would silently get the deployment-wide budget.
     */
    brandId: string | null,
  ): Promise<PoolOutcome> {
    const desk = await this.auth.listGroupMembers(accountId, groupId);

    /**
     * ⭐ Feature 031 (roadmap 4.20/4.21, ADR 0042) — **is this desk fed by the router at all?**
     *
     * Asked FIRST, and asked about the desk rather than about the people on it. That is the whole of
     * option C: the router never wanted to know anybody's role, it wanted to know whether this desk
     * receives pushed work. Asking about the person was a proxy, and a proxy that needs an exception the
     * moment an account manager legitimately belongs to a mixed desk.
     *
     * ⚠️ **This closes a real hole, not a hypothetical one.** Until now the pool was built from group
     * MEMBERSHIP alone, so an account manager in a routed group could be auto-assigned — exactly what
     * roadmap 4.14 promised would not happen. Feature 030's guard was green throughout and correctly so:
     * it forbids routing modules from *naming* an AM role, and none of them did. **A guard against
     * naming a thing is not a proof that the thing cannot happen.**
     *
     * ⓘ Refused with its own outcome rather than by returning an empty pool — see `DESK_NOT_ROUTABLE`.
     * "Nobody staffs this desk" and "this desk is not a queue" send an administrator to different places.
     */
    if (!desk.routable) return { candidates: [], reason: DESK_NOT_ROUTABLE };

    const memberUserIds = desk.userIds;
    if (memberUserIds.length === 0) return { candidates: [], reason: null };

    const resolved = await this.users.resolveOperators(accountId, memberUserIds, metadata);
    if (resolved.length === 0) return { candidates: [], reason: null };

    // ── Feature 025 (roadmap 5.9): availability, and where the two "no"s differ ──────────────────
    //
    // `users` already dropped anyone whose staff account is deactivated — they have LEFT. This drops
    // anyone who is not at their desk right now. Both produce a smaller pool and they are different
    // facts; the distinction is why they are applied in two places rather than folded into one flag.
    //
    // The ask is `new_push`: this is the ROUTER handing out work nobody asked for. A human handing a
    // conversation to a colleague asks the other question, and `transfers_only` is precisely the
    // state where the two answers differ — see `stateAllows` in @crm/common.
    //
    // ⚠️ An empty result here still means "this desk has nobody available", never "I could not find
    // out". The clients above RAISE when they cannot establish an answer, so unavailability is always
    // a fact rather than a silence — the property this file's header has guaranteed since 024, now
    // extended rather than weakened.
    const operators = resolved.filter((o) =>
      isAvailableFor({
        ask: 'new_push',
        // Already true by construction: `users` returns active profiles only. Passed explicitly so
        // the predicate reads the same here as everywhere else it is used.
        operatorActive: true,
        state: o.state,
        channel,
        blockedChannels: o.blockedChannels,
      }),
    );
    if (operators.length === 0) return { candidates: [], reason: null };

    const load = await this.currentLoad(
      accountId,
      operators.map((o) => o.operatorId),
    );
    // Feature 031: per-brand budget, falling back to the deployment default. Read per decision, so an
    // administrator's change applies to the next routing decision with no restart.
    const budget = capacityForBrand(brandId ?? null);

    // Sorted by operator id, deliberately: the rotation cursor is an INDEX into this list, so an
    // unstable order would make the cursor point at a different person between calls and quietly
    // break the fairness property feature 013 proved.
    return {
      reason: null,
      candidates: operators
      .map((o) => {
        const held = load.get(o.operatorId) ?? [];
        const used = unitsUsed(held);
        /**
         * ⭐ Feature 031: the SAME predicate the rotation already applies (`load < capacity`), fed with
         * units instead of a row count — so `exclusive` is expressible without the rotation learning a
         * new concept. An agent holding an exclusive conversation is reported as full, which is exactly
         * what `hasRoomFor` decides; the decision stays in this file (one decision point).
         */
        return {
          operatorId: o.operatorId,
          capacity: budget,
          currentLoad: used === 'exclusive' ? budget : used,
        };
      })
        .sort((a, b) => a.operatorId.localeCompare(b.operatorId)),
    };
  }

  /**
   * How much work each candidate is already holding.
   *
   * ONE grouped query, not one per candidate (Principle VII) — the shape feature 022 established for
   * summary reads. An operator with nothing open is absent from the result and defaults to 0, which
   * is why the caller reads through a `Map` rather than expecting a row per candidate.
   */
  private async currentLoad(
    accountId: string,
    operatorIds: readonly string[],
  ): Promise<Map<string, HeldConversation[]>> {
    if (operatorIds.length === 0) return new Map();
    // `as never` on the argument: Prisma's `groupBy` overload demands `orderBy` whenever `by` is a
    // non-literal array, and there is nothing to order — one row per operator, read into a Map. The
    // same cast the feature-022 summary read uses, for the same reason.
    /**
     * ⚠️ Feature 031: this used to be a `groupBy` COUNT, and a count cannot express a unit.
     *
     * ADR 0042 §3 prices work per channel — a voice call is exclusive, a chat costs one — so the load has
     * to carry **which channels** the person is holding, not how many rows. The read is still one query
     * over an indexed column and still returns only what capacity needs: a channel per held conversation
     * and nothing else. No subject, no player, no body (Principle IV).
     */
    const rows = await this.prisma.forAccount(accountId).conversation.findMany({
      where: {
        assignee_operator_id: { in: [...operatorIds] },
        status: { in: [...OPEN_STATUSES] },
      },
      select: { assignee_operator_id: true, channel: true },
    });

    const out = new Map<string, HeldConversation[]>();
    for (const r of rows) {
      const id = r.assignee_operator_id;
      if (!id) continue;
      const held = out.get(id) ?? [];
      held.push({ channel: r.channel });
      out.set(id, held);
    }
    return out;
  }
}
