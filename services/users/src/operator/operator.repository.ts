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
}
