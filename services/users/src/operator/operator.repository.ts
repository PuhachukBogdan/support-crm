import { Inject, Injectable } from '@nestjs/common';
import { isPresenceState, type PresenceState } from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * A member of staff who can be handed work, and everything needed to decide whether they can be
 * handed it right now (feature 024 → 025).
 *
 * ⚠️ `active` is NOT part of this shape and never will be: this list contains only active operators
 * by construction, so a field saying so would be a constant that a future edit could make lie.
 */
export interface ResolvedOperator {
  operatorId: string;
  authUserId: string;
  state: PresenceState;
  /** ONLY the switched-off channels. Absence means available (FR-019). */
  blockedChannels: string[];
}

/**
 * Read path for the Operator entity (feature 018, roadmap 5.1).
 *
 * A member of STAFF, not a customer — which is why this lives in its own folder rather than beside the
 * player code. The rules genuinely differ: no tier masking (the visibility policy classifies *customer*
 * fields) and no access audit (an operator's display name already renders on every message they sent).
 * Putting the two side by side would invite one to inherit the other's treatment by proximity, and the
 * direction that mistake goes in is "the staff read quietly stopped being audited" or "the customer read
 * quietly stopped being masked".
 *
 * `auth_user_id` is a SOFT reference to the identity record and is never joined across the service
 * boundary (Principle VIII). This feature does not resolve it either — it returns the operator's own
 * fields and nothing more.
 *
 * `findFirst` rather than `findUnique`, so the `account_id` the isolation extension injects composes as
 * an ordinary predicate. The consequence is the one Principle I wants: "not yours" and "does not exist"
 * are the **same query result**, so there is no `row.account_id !== caller` comparison in this file for a
 * later edit to split into two different answers.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface OperatorRow {
  id: string;
  account_id: string;
  display_name: string | null;
  active: boolean;
}

const ROW_SELECT = {
  id: true,
  account_id: true,
  display_name: true,
  // Returned, NOT filtered on: an inactive operator's name still has to render on last year's
  // conversations. Hiding them would make historical threads show an empty author.
  active: true,
} as const;

@Injectable()
export class OperatorRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** One operator, account-scoped. `null` for unknown **and** for another account's id — the same answer. */
  async getById(accountId: string, operatorId: string): Promise<OperatorRow | null> {
    if (!operatorId) return null;
    return (await this.prisma.forAccount(accountId).operator.findFirst({
      where: { id: operatorId },
      select: ROW_SELECT,
    })) as OperatorRow | null;
  }

  /**
   * Translate AUTH user ids into ASSIGNABLE operator profiles (feature 024, roadmap 5.3).
   *
   * Group membership is keyed on the auth identity — that is the subject the permission resolver
   * keys on, and anything else would need translating on the hot permission path. A conversation's
   * assignee, however, is an operator profile. This is the one place the two meet, and it is an
   * explicit call rather than a join because they live in different databases (Principle VIII).
   *
   * ⚠️ **ACTIVE profiles only, and a member with no profile is simply ABSENT.** Fail-closed: an
   * identity that cannot be resolved to someone who can hold work is not a routing candidate. The
   * caller compares the count it asked for with the count it got back, which is what turns "the pool
   * is empty" from a mystery into a fact with a reason.
   *
   * Unlike `getById` this filters on `active`, and the contrast is deliberate: that read answers
   * "who wrote this?" about the past, where an inactive operator's name must still render; this one
   * answers "who can take this work?" about the present, where it must not.
   */
  async resolveByAuthUserIds(
    accountId: string,
    authUserIds: readonly string[],
  ): Promise<ResolvedOperator[]> {
    const ids = [...new Set(authUserIds.filter((id) => id))];
    if (ids.length === 0) return [];
    const db = this.prisma.forAccount(accountId);

    const rows = (await db.operator.findMany({
      where: { auth_user_id: { in: ids }, active: true },
      select: { id: true, auth_user_id: true },
    })) as { id: string; auth_user_id: string }[];
    if (rows.length === 0) return [];

    // ── Feature 025 (roadmap 5.9): the same question, answered completely ────────────────────────
    //
    // ⚠️ `active` above and `state` below are DIFFERENT FACTS and must never be merged. `active`
    // means the staff account is not deactivated (roadmap 3.16) — that person has left. `state`
    // means they are not at their desk right now — that person is at lunch. Reporting one as the
    // other is the collision this feature was warned about (FR-034), and this method is where the
    // two meet.
    //
    // They are read together because they answer the same QUESTION: who can take this work? A caller
    // that had to fetch presence separately is a caller that can forget to.
    //
    // Two queries for the whole set, never one per candidate — this sits on the auto-assignment path
    // (Principle VII).
    const present = rows.map((r) => r.auth_user_id);
    const [presence, blocks] = await Promise.all([
      db.operatorPresence.findMany({
        where: { auth_user_id: { in: present } },
        select: { auth_user_id: true, state: true },
      }) as Promise<Array<{ auth_user_id: string; state: string }>>,
      db.operatorChannelBlock.findMany({
        where: { auth_user_id: { in: present } },
        select: { auth_user_id: true, channel: true },
      }) as Promise<Array<{ auth_user_id: string; channel: string }>>,
    ]);

    const stateOf = new Map(presence.map((p) => [p.auth_user_id, p.state]));
    const blockedOf = new Map<string, string[]>();
    for (const b of blocks) {
      const list = blockedOf.get(b.auth_user_id);
      if (list) list.push(b.channel);
      else blockedOf.set(b.auth_user_id, [b.channel]);
    }

    return rows.map((r) => ({
      operatorId: r.id,
      authUserId: r.auth_user_id,
      // Absent row ⇒ `offline` (FR-011). Presence is a statement about a LIVE SESSION; somebody who
      // has never started a shift is honestly reported as not at their desk, and no caller needs a
      // special case for it.
      state: (isPresenceState(stateOf.get(r.auth_user_id))
        ? (stateOf.get(r.auth_user_id) as PresenceState)
        : 'offline'),
      blockedChannels: blockedOf.get(r.auth_user_id) ?? [],
    }));
  }

  /**
   * ⭐ W35 / feature 040 — auth identities → the NAME to print beside something they wrote.
   *
   * ── ⚠️ Why this is not `resolveByAuthUserIds` one method up ──────────────────────────────────────
   * That method's own doc states the distinction and this feature is the case it predicted: *"`getById`
   * answers «who wrote this?» about the past, where an inactive operator's name must still render; this
   * one answers «who can take this work?» about the present, where it must not."* It filters
   * `active: true` and returns no display name at all.
   *
   * A player note is exactly the first kind of question. Reusing the routing read would have made every
   * note written by somebody who has since left the company render **unattributed** — quietly, only for
   * departed authors, and precisely in the scenario the block exists for: W32 hands a portfolio over
   * when somebody leaves, and their notes are what the successor inherits. The signature the operator
   * asked for (*«каждая подписана автором и датой»*) would have failed for the very authors whose
   * context is most easily mistaken for the reader's own.
   *
   * So: no `active` filter, names only, one query for the whole page (Principle VII — this list is read
   * on the busiest customer surface in the product).
   *
   * ⓘ A missing id is simply absent from the result, and the caller shows the reference instead of
   * inventing a placeholder name. An id from another account is absent too — same query result, no
   * comparison in this file to split later.
   */
  async namesByAuthUserIds(
    accountId: string,
    authUserIds: readonly string[],
  ): Promise<Array<{ authUserId: string; displayName: string }>> {
    const ids = [...new Set(authUserIds.filter((id) => id))];
    if (ids.length === 0) return [];
    const rows = (await this.prisma.forAccount(accountId).operator.findMany({
      where: { auth_user_id: { in: ids } },
      select: { auth_user_id: true, display_name: true },
    })) as Array<{ auth_user_id: string; display_name: string | null }>;
    return rows.map((r) => ({ authUserId: r.auth_user_id, displayName: r.display_name ?? '' }));
  }
}
