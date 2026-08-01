/**
 * In-process domain events (feature 014, roadmap 4.6 — research R4/R6).
 *
 * ── Why events at all ────────────────────────────────────────────────────────────────────────────
 * An automation rule reacts to something happening. That "something" is a write that already
 * succeeded, so the engine needs a notification, not a hook inside the write.
 *
 * ── The no-cascade rule, made structural ─────────────────────────────────────────────────────────
 * These events are published **only from gRPC controllers** — the edge where a human or an inbound
 * channel caused the change. The automation engine performs its own writes through the same
 * repositories the controllers use, and repositories never publish. An automation's writes therefore
 * *cannot* emit an event, so there is no reaction chain to bound and no loop to detect (FR-006).
 *
 * That is deliberate: a `suppressEvents` flag would be one forgotten argument away from an infinite
 * loop in production. `no-publish-from-repositories.spec.ts` keeps the structure honest.
 *
 * ── event_key ───────────────────────────────────────────────────────────────────────────────────
 * Every event carries a key derived from the FACT that caused it, so a redelivery produces the same
 * key while a genuine repeat produces a new one. Combined with the unique index on
 * `(automation_id, conversation_id, event_key)`, that constraint — not application bookkeeping — is
 * what makes a rule apply at most once per event (FR-008).
 */

export const AUTOMATION_TRIGGERS = [
  'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
  'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
  'AUTOMATION_TRIGGER_STATUS_CHANGED',
  'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
] as const;

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const isAutomationTrigger = (t: unknown): t is AutomationTrigger =>
  typeof t === 'string' && (AUTOMATION_TRIGGERS as readonly string[]).includes(t);

/**
 * The facts a condition can be evaluated against. `messageText` is present only for a
 * MESSAGE_RECEIVED event and is used for matching **in memory only** — it is never written to a run
 * record, a log or an error payload (FR-020 / SEC-26).
 */
export interface ConversationFacts {
  status: string;
  priority: string | null;
  brandId: string;
  channel: string | null;
  hasAssignee: boolean;
  labelIds: string[];
  messageText?: string;
  /**
   * Feature 024 (roadmap 5.3): which DESK the conversation was routed to, or null.
   *
   * It is NOT a condition field — no rule author writes `routedGroupId == …`. It is the fact the
   * engine matches a rule's own group SCOPE against, which is a different thing: a scope narrows
   * which work a rule sees at all, while a condition is something the author reasons about.
   */
  routedGroupId: string | null;
}

export interface DomainEvent {
  trigger: AutomationTrigger;
  accountId: string;
  conversationId: string;
  /** Deterministic per event occurrence — see the module comment. */
  eventKey: string;
  facts: ConversationFacts;
}

// ── event_key builders (the only sanctioned way to make one) ─────────────────────────────────────

/** A conversation is created once; its id identifies the occurrence. */
export const conversationCreatedKey = (conversationId: string): string => `conv:${conversationId}`;

/** A message exists once; its id identifies the occurrence. */
export const messageReceivedKey = (messageId: string): string => `msg:${messageId}`;

/**
 * A status change has no id of its own, so the key is the resulting state plus the write's own
 * timestamp: a redelivery of the same write repeats it, while changing to the same status again
 * later is a genuinely new occurrence.
 */
export const statusChangedKey = (
  conversationId: string,
  newStatus: string,
  updatedAt: Date,
): string => `status:${conversationId}:${newStatus}:${updatedAt.getTime()}`;

/**
 * Deliberately timestamp-free: a conversation breaches its FIRST-reply target once, ever. Even if
 * the sweep were to see the row twice, the key is identical, so the unique index refuses the second
 * application (US3 acceptance #4).
 */
export const firstReplyBreachedKey = (conversationId: string): string =>
  `breach:${conversationId}`;
