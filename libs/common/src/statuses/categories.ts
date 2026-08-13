/**
 * The closed status-CATEGORY catalogue (feature 032, roadmap 4.16 — ADR 0040 §1).
 *
 * ── Two levels, and only one of them is code ─────────────────────────────────────────────────────
 * A **category** is what machine logic may branch on: the SLA clock's pause (0041), the terminal
 * condition that removes a ticket from the agent's rail (0042), the "unsolved" scopes, the reporting
 * buckets. There are six, the set is closed, and adding one is a deliberate edit here.
 *
 * A **status** is per-account CONFIGURATION and lives in `chats_db` — `key`, `category`,
 * `agent_name`, `end_user_name`, `active`, `order`. It is data precisely so that a supervisor can add
 * *Waiting for finance* without a migration and without any code learning the word.
 *
 * ⚠️ **NO CODE BRANCHES ON A STATUS KEY.** That is the entire premise: the operator's complaint about
 * their live system — *«сейчас всё валится в on hold»* — is what happens when every new operational
 * state has to become a value the machine already understands. `tests/statuses/no-status-key-branch.spec.ts`
 * asserts it as a scan over `chats/src` rather than trusting it as a style preference, exactly as
 * feature 016 did for upload purposes.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────────
 * `pausesSla`. Roadmap **4.17** owns pause semantics (`Pending` stops the clock, `On-hold` does not —
 * ADR 0041) and adds the field together with the code that reads it. A property defined here today
 * would have no reader, which is the `display_name` mistake block W1 caught before shipping.
 *
 * Pure data + pure helpers. No I/O.
 */

/** The six categories, in workflow order. The `order` of a status is separate and is per-account data. */
export const STATUS_CATEGORY_KEYS = [
  'new',
  'open',
  'pending',
  'on_hold',
  'solved',
  'closed',
] as const;

export type StatusCategory = (typeof STATUS_CATEGORY_KEYS)[number];

export interface StatusCategorySpec {
  /** One line a reader of the catalogue (not of the code) can understand. */
  label: string;
  /**
   * The work is finished. Consumers today: the agent-load count (a terminal conversation occupies
   * nobody) and, at 4.19, the rail's exit condition.
   *
   * ⚠️ `solved` and `closed` are BOTH terminal and are still two categories. 0041 and 0042 need the
   * distinction (a solved ticket may reopen; a closed one is archived), and inventing `closed` later
   * would mean re-deciding what every existing `solved` row meant.
   */
  terminal: boolean;
  /** The proto enum value. Explicit, never derived by string munging — see `wire.ts`'s precedent. */
  wire: string;
  /**
   * ⭐ Feature 033 (roadmap 6.4, FR-029): a customer's reply arrives on a ticket in this category —
   * does the ticket COME BACK, or does the reply become a new ticket that records what it continues?
   *
   * Only consulted for a **terminal** category; a non-terminal ticket simply gains the message, so the
   * value there is `false` in the sense of "there is nothing to reopen".
   *
   * ⚠️ **This is here, as data, so that no code has to name a category.** The alternative was
   * `category === 'solved'` inside the intake path — which `tests/statuses/no-status-key-branch.spec.ts`
   * refused, correctly: `solved` is simultaneously a category name and a seeded status KEY, and a
   * comparison against that word cannot be told apart from the branching ADR 0040 exists to forbid. The
   * guard did not merely block a line; it pointed at the property that was missing from the model.
   *
   * The two answers, and why they differ: a **solved** ticket the customer answers was not finished, so
   * it returns to the rail. A **closed** one is final — reviving it would put it back into routing,
   * restart an SLA clock against a date that has passed, and change a closed-work number for a period
   * already reported.
   */
  reopenOnCustomerReply: boolean;
}

export const STATUS_CATEGORIES: Readonly<Record<StatusCategory, StatusCategorySpec>> = {
  new: {
    label: 'Not yet picked up',
    terminal: false,
    wire: 'CONVERSATION_STATUS_CATEGORY_NEW',
    reopenOnCustomerReply: false,
  },
  open: {
    label: 'Being worked on',
    terminal: false,
    wire: 'CONVERSATION_STATUS_CATEGORY_OPEN',
    reopenOnCustomerReply: false,
  },
  pending: {
    // ⚠️ Waiting on the CUSTOMER. This is the one category 0041 pauses the clock for, and the reason
    // the rail returns a Pending ticket automatically when the customer replies (R17a): the agent sets
    // it, so an exit with no way back would let six tickets be parked out of sight by six clicks.
    label: 'Waiting for the customer',
    terminal: false,
    wire: 'CONVERSATION_STATUS_CATEGORY_PENDING',
    reopenOnCustomerReply: false,
  },
  on_hold: {
    // Waiting on US — an escalation, a colleague, a third party. NOT a pause: an escalated ticket is
    // our work, not the player's (ADR 0041 / 0045).
    label: 'Waiting on us',
    terminal: false,
    wire: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD',
    reopenOnCustomerReply: false,
  },
  solved: {
    label: 'Resolved, may still reopen',
    terminal: true,
    wire: 'CONVERSATION_STATUS_CATEGORY_SOLVED',
    // ⭐ The one `true` in the catalogue, and the label above already said so before the channel existed:
    // "may still reopen". Feature 033 made the sentence executable.
    reopenOnCustomerReply: true,
  },
  closed: {
    // No seeded status belongs to it yet (ADR 0040 §3): the rule that would move a solved ticket here
    // is retention, and retention (SEC-25) is open. The category exists so that rule adds a ROW.
    label: 'Archived',
    terminal: true,
    wire: 'CONVERSATION_STATUS_CATEGORY_CLOSED',
    // Final. A reply becomes a NEW ticket carrying a link to this one (FR-029b).
    reopenOnCustomerReply: false,
  },
};

export const isStatusCategory = (value: unknown): value is StatusCategory =>
  typeof value === 'string' && (STATUS_CATEGORY_KEYS as readonly string[]).includes(value);

/** The categories a conversation can still be worked in. The agent-load count reads this. */
export const NON_TERMINAL_CATEGORIES: readonly StatusCategory[] = STATUS_CATEGORY_KEYS.filter(
  (k) => !STATUS_CATEGORIES[k].terminal,
);

export const TERMINAL_CATEGORIES: readonly StatusCategory[] = STATUS_CATEGORY_KEYS.filter(
  (k) => STATUS_CATEGORIES[k].terminal,
);

export const isTerminalCategory = (category: string): boolean =>
  isStatusCategory(category) && STATUS_CATEGORIES[category].terminal;

/** `undefined` = no category asked for (absent or UNSPECIFIED). `null` = a value the wire does not define. */
export function categoryFromWire(wire: string | undefined): StatusCategory | undefined | null {
  if (!wire || wire === 'CONVERSATION_STATUS_CATEGORY_UNSPECIFIED') return undefined;
  const found = STATUS_CATEGORY_KEYS.find((k) => STATUS_CATEGORIES[k].wire === wire);
  return found ?? null;
}

/** A stored category → its proto value. An unknown value yields UNSPECIFIED, never a guess. */
export function categoryToWire(category: string): string {
  return isStatusCategory(category)
    ? STATUS_CATEGORIES[category].wire
    : 'CONVERSATION_STATUS_CATEGORY_UNSPECIFIED';
}
