import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NOT_SHELVED } from './shelf';

/**
 * ⭐ W25 (R23 / roadmap 9.12) — the unread badge's TWO operations, and nothing else.
 *
 * The operator's counter rules are all consequences of one fact — "when did this operator last look
 * at the Inbox LIST" — so that fact is the only thing stored (`InboxOpenMark`, one row per
 * (account, operator)) and the count is DERIVED on read:
 *
 *   count = conversations WHERE assignee = me ∧ status ∈ (the Inbox bucket's keys) ∧ created > opened
 *
 * · Inbox closed + ticket arrives → the predicate now matches one more row (+1);
 * · opening the Inbox advances `opened_at` → the predicate matches nothing (reset);
 * · Inbox OPEN + ticket arrives → the screen re-marks on arrival, so it never counts
 *   («он сразу просмотрен» — the client's half of rule 2);
 * · a reload answers from here, because nothing was ever accumulated client-side.
 *
 * ⚠️ `operatorId` comes from the CALLER's resolved identity (the read-mark rule): both rpcs take an
 * EMPTY request, so nobody can ask about — or reset — somebody else's badge.
 *
 * ⓘ The arrival fact is `created_at`. A REASSIGNMENT of an old conversation into my slice does not
 * count — recorded, not overlooked: in this product the router assigns fresh tickets seconds after
 * creation, and the operator's own words were «при возникновении НОВОГО тикета». If hand-offs of old
 * tickets ever need to badge, the fact to add is an assignment timestamp, not a wider predicate.
 */
@Injectable()
export class InboxUnseenRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The reset act. Idempotent by the PK upsert; returns the new mark so the caller renders 0. */
  async markOpened(accountId: string, operatorId: string): Promise<Date> {
    const now = new Date();
    await this.prisma.forAccount(accountId).inboxOpenMark.upsert({
      where: { account_id_operator_id: { account_id: accountId, operator_id: operatorId } },
      // account_id is also injected by the scoped client (feature 007); set explicitly to the same
      // value so the static create type is satisfied (the extension applies it last).
      create: { account_id: accountId, operator_id: operatorId, opened_at: now },
      update: { opened_at: now },
    });
    return now;
  }

  /**
   * The derived count + the mark itself (the list uses `openedAt` to dot the ROWS that arrived
   * while the operator was away — one fact, two surfaces).
   *
   * `inboxStatusKeys` is the account's own keys of the Inbox bucket's CATEGORIES (new + open, R39),
   * resolved by the controller against the catalogue — this repository never reads the catalogue,
   * so it cannot answer about a vocabulary the caller did not resolve. `[]` counts nothing, honestly.
   * No mark ⇒ everything in the slice is unseen — a first-ever visitor has seen nothing.
   */
  async unseen(
    accountId: string,
    operatorId: string,
    inboxStatusKeys: string[],
  ): Promise<{ count: number; openedAt: Date | null }> {
    const db = this.prisma.forAccount(accountId);
    const mark = await db.inboxOpenMark.findUnique({
      where: { account_id_operator_id: { account_id: accountId, operator_id: operatorId } },
      select: { opened_at: true },
    });
    const count = await db.conversation.count({
      where: {
        assignee_operator_id: operatorId,
        status: { in: inboxStatusKeys },
        // W27 / 036: a shelved arrival wakes nothing — the badge counts work, and shelved is not work.
        ...NOT_SHELVED,
        ...(mark ? { created_at: { gt: mark.opened_at } } : {}),
      },
    });
    return { count, openedAt: mark?.opened_at ?? null };
  }
}
