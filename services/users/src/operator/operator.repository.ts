import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

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
  ): Promise<{ operatorId: string; authUserId: string }[]> {
    const ids = [...new Set(authUserIds.filter((id) => id))];
    if (ids.length === 0) return [];
    const rows = (await this.prisma.forAccount(accountId).operator.findMany({
      where: { auth_user_id: { in: ids }, active: true },
      select: { id: true, auth_user_id: true },
    })) as { id: string; auth_user_id: string }[];
    return rows.map((r) => ({ operatorId: r.id, authUserId: r.auth_user_id }));
  }
}
