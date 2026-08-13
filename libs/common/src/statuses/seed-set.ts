/**
 * The nine statuses this support team already works by, and the map from the vocabulary the product
 * shipped (feature 032, roadmap 4.16 — ADR 0040 §3 / §5).
 *
 * ── Why the seed set lives in shared code rather than in the seed script ─────────────────────────
 * Three places have to agree about it: the SQL migration that backfills existing accounts, the seed
 * that provisions a fresh one, and the tests that assert both. Two copies of nine rows is two chances
 * to disagree in a way nothing detects until an account has statuses the other half of the product
 * cannot resolve.
 *
 * ⚠️ **This is data, not the model.** After the migration, statuses are per-account rows a supervisor
 * edits (the W15a authoring screen, roadmap 3.14). Nothing may read this constant to decide behaviour
 * — it exists to CREATE rows, and the product then reads the rows. The structural guard that bans
 * status-key branching covers `chats/src`, so a service reaching back into this list would be visible.
 */
import type { StatusCategory } from './categories';

export interface SeededStatus {
  key: string;
  category: StatusCategory;
  /** What the agent sees. */
  agentName: string;
  /**
   * What the customer sees. ⚠️ NO CONSUMER UNTIL PHASE 6 (U10) — there is no customer-facing surface
   * yet. Populated anyway: an unused field with a named consumer is not an unfinished feature, and
   * dual naming cannot be retrofitted from data (ADR 0040 §2). `In progress` means *escalated,
   * being worked on* internally while the player is shown a neutral `Open`.
   */
  endUserName: string;
  /** Display order within the account. Contiguous by ten, so a later insert needs no renumbering. */
  order: number;
}

export const SEEDED_STATUSES: readonly SeededStatus[] = [
  { key: 'new', category: 'new', agentName: 'New', endUserName: 'Open', order: 10 },
  { key: 'open', category: 'open', agentName: 'Open', endUserName: 'Open', order: 20 },
  {
    key: 'pending',
    category: 'pending',
    agentName: 'Pending',
    endUserName: 'Awaiting your reply',
    order: 30,
  },
  {
    key: 'vip_pending',
    category: 'pending',
    agentName: 'VIP Pending',
    endUserName: 'VIP Pending',
    order: 40,
  },
  {
    key: 'in_progress',
    category: 'on_hold',
    agentName: 'In progress',
    endUserName: 'Open',
    order: 50,
  },
  { key: 'follow_up', category: 'on_hold', agentName: 'Follow-up', endUserName: 'Open', order: 60 },
  {
    key: 'auto_ended_chat',
    category: 'on_hold',
    agentName: 'Auto-Ended Chat',
    endUserName: 'Open',
    order: 70,
  },
  {
    key: 'supervisor_review',
    category: 'on_hold',
    agentName: 'Supervisor Review – In Progress',
    endUserName: 'Open',
    order: 80,
  },
  { key: 'solved', category: 'solved', agentName: 'Solved', endUserName: 'Solved', order: 90 },
];

/**
 * The vocabulary feature 012 shipped → the key it becomes (ADR 0040 §5).
 *
 * `snoozed → pending` is the one that loses something, and it loses nothing real: it came from the
 * Chatwoot blueprint and never had a distinct meaning in this product. Deciding it HERE, in the same
 * file the migration reads, is what keeps it from being decided twice.
 *
 * ⚠️ Only the migration and the seed may use this. It is NOT a wire mapping: the legacy proto enum is
 * refused on the wire rather than mapped, because in the FILTER direction the mapping is lossy —
 * asking for `SNOOZED` would return every pending conversation, which is a confident wrong answer.
 */
export const LEGACY_STATUS_MIGRATION: Readonly<Record<string, string>> = {
  open: 'open',
  pending: 'pending',
  resolved: 'solved',
  snoozed: 'pending',
};

/**
 * The proto enum names stored INSIDE macro and automation definitions, and the key each becomes.
 *
 * A stored definition holds `CONVERSATION_STATUS_PENDING` in a JSON column (feature 013's
 * `MACRO_ACTION_TYPE_SET_STATUS` value). Left alone, such a rule names a status nothing can resolve —
 * and it would fail at APPLY time, on a customer's conversation, rather than at deploy time.
 */
/**
 * The retired enum's zero value, which is what proto-loader sends for an UNSET enum field.
 *
 * ⚠️ It lives HERE, beside the rest of the retired vocabulary, rather than in the chats service — and the
 * reason is not tidiness. `status-filter.ts` has to recognise this exact token to tell *"the caller sent no
 * legacy filter"* from *"the caller sent a legacy filter we must refuse"*, and it is the ONLY thing in the
 * product that still needs to know a `CONVERSATION_STATUS_*` member by name.
 *
 * Keeping it in shared code with the migration maps means the structural guard
 * (`tests/statuses/no-status-key-branch.spec.ts`) can say something absolute — *no chats source file names
 * a retired enum member* — instead of carrying an exemption that the next reader would widen.
 */
export const LEGACY_STATUS_WIRE_UNSPECIFIED = 'CONVERSATION_STATUS_UNSPECIFIED';

export const LEGACY_STATUS_WIRE_MIGRATION: Readonly<Record<string, string>> = {
  CONVERSATION_STATUS_OPEN: 'open',
  CONVERSATION_STATUS_PENDING: 'pending',
  CONVERSATION_STATUS_RESOLVED: 'solved',
  CONVERSATION_STATUS_SNOOZED: 'pending',
};
