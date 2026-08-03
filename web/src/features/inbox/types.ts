/**
 * A conversation as the gateway's list returns it (feature 029).
 *
 * ⚠️ Mirrors `ConversationSummary` in `libs/proto/crm/chats/v1/chats.proto` — the contract is there,
 * not here. Two fields are named differently from what they look like, and both cost this feature a
 * near-miss:
 *
 *  • `lastActivityAt` **is `updated_at`** (research R7). There is no `last_activity_at` column. The
 *    screen therefore labels it "Updated" and never claims customer activity.
 *  • `playerId` is the only thing the product knows about the customer (research R9) — there is no
 *    name, email or phone at any tier, so nothing resolves it into a person.
 *
 * The transport passes records through untouched, so every string may legitimately be empty: the
 * server decides what a caller sees, and inventing a default here would reconstruct a disclosure it
 * deliberately withheld.
 */
export interface ConversationRow {
  id: string;
  brandId: string;
  playerId: string;
  status: string;
  priority: string;
  assigneeOperatorId: string;
  channel: string;
  /** ⚠️ `updated_at` under another name (R7). Rendered as "Updated". */
  lastActivityAt: string;
  createdAt: string;
  subject: string;
  /** Present on the detail read; absent from the summary today. Rendered as "not set". */
  category?: string;
}

/** What the column table keys on — see `columns.ts`. */
export type ConversationField = keyof ConversationRow;
