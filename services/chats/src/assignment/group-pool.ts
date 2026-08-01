import { Inject, Injectable } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import { PrismaService } from '../prisma.service';
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

/** Statuses that count against an operator's load: work that is still theirs to finish. */
const OPEN_STATUSES = ['open', 'pending'] as const;

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
  ): Promise<RoundRobinCandidate[]> {
    const memberUserIds = await this.auth.listGroupMembers(accountId, groupId);
    if (memberUserIds.length === 0) return [];

    const resolved = await this.users.resolveOperators(accountId, memberUserIds, metadata);
    if (resolved.length === 0) return [];

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
    if (operators.length === 0) return [];

    const load = await this.currentLoad(
      accountId,
      operators.map((o) => o.operatorId),
    );
    const capacity = defaultCapacity();

    // Sorted by operator id, deliberately: the rotation cursor is an INDEX into this list, so an
    // unstable order would make the cursor point at a different person between calls and quietly
    // break the fairness property feature 013 proved.
    return operators
      .map((o) => ({
        operatorId: o.operatorId,
        capacity,
        currentLoad: load.get(o.operatorId) ?? 0,
      }))
      .sort((a, b) => a.operatorId.localeCompare(b.operatorId));
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
  ): Promise<Map<string, number>> {
    if (operatorIds.length === 0) return new Map();
    // `as never` on the argument: Prisma's `groupBy` overload demands `orderBy` whenever `by` is a
    // non-literal array, and there is nothing to order — one row per operator, read into a Map. The
    // same cast the feature-022 summary read uses, for the same reason.
    const rows = (await this.prisma.forAccount(accountId).conversation.groupBy({
      by: ['assignee_operator_id'],
      where: {
        assignee_operator_id: { in: [...operatorIds] },
        status: { in: [...OPEN_STATUSES] },
      },
      _count: { _all: true },
    } as never)) as unknown as { assignee_operator_id: string | null; _count: { _all: number } }[];

    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.assignee_operator_id) out.set(r.assignee_operator_id, r._count._all);
    }
    return out;
  }
}
