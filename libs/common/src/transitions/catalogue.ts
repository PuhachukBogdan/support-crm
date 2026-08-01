/**
 * The closed transition catalogue (feature 023, roadmap 4.8a — ADR 0046).
 *
 * ── What a transition IS ─────────────────────────────────────────────────────────────────────────
 * One durable statement that something changed. Every metric this support team lives by — backlog,
 * reopened %, one-touch %, first reply time, per-agent load — is derived from transitions, not from a
 * row's current state. Store only current state and the past is permanently unanswerable.
 *
 * ── ⚠️ THREE THINGS WITH SIMILAR NAMES; DO NOT MERGE THEM ────────────────────────────────────────
 *   1. `AuditEntry` (feature 015, audit/catalogue.ts) — SENSITIVE ACTIONS. **Strict**: if the entry
 *      cannot be written, the action is refused. PII structurally inexpressible.
 *   2. `DomainEvent` (feature 014, chats/src/events/) — an in-process automation trigger. Synchronous,
 *      **deliberately lossy** (a throwing subscriber is swallowed), and it legitimately carries message
 *      text IN MEMORY.
 *   3. **This** — durable history. Best-effort delivery, atomic recording, ids and enums only.
 *
 * Merging 3 with 2 would land customer message bodies in an append-only store. That is why the word
 * "event" is not used anywhere in this feature, and why
 * `tests/transitions/no-dispatcher-crossover.spec.ts` fails the build if the two ever touch.
 *
 * ── Why types with no writer are here anyway ─────────────────────────────────────────────────────
 * The same reason the audit catalogue gives: feature 011 needed to record permission changes and
 * invented `PrivilegeAudit`, then needed contact views and invented `ContactViewAudit` — two stores,
 * two shapes, a reader who must know both. Defining `conversation.released` / `operator.presence_changed`
 * now means the feature that introduces them writes HERE.
 *
 * `status` is load-bearing, not documentation:
 *   • `live`          — a writer exists in the product today.
 *   • `no-writer-yet` — defined; the feature that emits it has not shipped.
 * `catalogue.spec.ts` asserts the exact membership of each, so promoting one is a visible act.
 *
 * Pure data + pure helpers. No I/O.
 */

/** What a transition can be about. Closed: a new subject kind is a deliberate addition. */
export const TRANSITION_SUBJECTS = ['conversation', 'escalation', 'operator', 'staff'] as const;
export type TransitionSubject = (typeof TRANSITION_SUBJECTS)[number];

/** Which service owns the writer (and therefore the table the row lands in — never a shared table). */
export type TransitionWriter = 'chats' | 'users' | 'auth' | 'worker';

export type TransitionStatus = 'live' | 'no-writer-yet';

export interface TransitionSpec {
  subject: TransitionSubject;
  writer: TransitionWriter;
  status: TransitionStatus;
  /** One line a reader of the catalogue (not of the code) can understand. */
  label: string;
  /**
   * The single documented exception to SEC-26 (ADR 0046 §5): this class stores a ONE-WAY hash of a
   * searched contact value plus the kind of value. Restricted access, short retention, its own
   * retention window. No writer exists today and `payload.spec.ts` keeps it that way.
   */
  restricted?: true;
}

export const TRANSITION_TYPES = {
  // ── live: written by this feature (chats) ──
  'conversation.status_changed': {
    subject: 'conversation',
    writer: 'chats',
    status: 'live',
    label: 'Conversation status changed',
  },
  'conversation.assigned': {
    subject: 'conversation',
    writer: 'chats',
    status: 'live',
    // One type covers assign / reassign / unassign: `from` and `to` are both nullable, so the three
    // are readings of one fact rather than three vocabularies that can drift apart.
    label: 'Conversation assigned, reassigned or unassigned',
  },
  'conversation.first_public_reply': {
    subject: 'conversation',
    writer: 'chats',
    status: 'live',
    label: 'First public reply sent to the customer',
  },
  'conversation.subject_set': {
    subject: 'conversation',
    writer: 'chats',
    status: 'live',
    // ⚠️ The payload carries `{ source }` and NEVER the title itself (payload.ts / T008). The title is
    // the customer's own words; copying it here would put customer text into an append-only store.
    //
    // Why this is a transition and not an audit action: it was drafted as one, and no honest class
    // existed for it among privilege / deletion / access / export / assignment / retention. That
    // difficulty was the answer — ADR 0019 records SENSITIVE actions, and editing a title exposes
    // nothing, changes no privilege and deletes nothing. It is a state change with an actor and a
    // time, which is exactly what this store is for (data-model §4).
    label: 'Conversation title set, automatically or by a person',
  },

  // ── no-writer-yet: defined so the feature that needs them writes HERE ──
  'conversation.released': {
    subject: 'conversation',
    writer: 'chats',
    status: 'no-writer-yet',
    label: 'Work handed back with a reason (roadmap 4.20)',
  },
  'conversation.player_attached': {
    subject: 'conversation',
    writer: 'chats',
    status: 'no-writer-yet',
    label: 'Conversation attached to a customer (roadmap 6.7)',
  },
  'conversation.player_detached': {
    subject: 'conversation',
    writer: 'chats',
    status: 'no-writer-yet',
    label: 'Conversation detached from a customer (roadmap 6.7)',
  },
  'escalation.status_changed': {
    subject: 'escalation',
    writer: 'chats',
    status: 'no-writer-yet',
    label: 'Escalation status changed (roadmap E2)',
  },
  'escalation.waiting_changed': {
    subject: 'escalation',
    writer: 'chats',
    status: 'no-writer-yet',
    label: 'Escalation started or stopped waiting on a third party (roadmap E2)',
  },
  'operator.presence_changed': {
    subject: 'operator',
    writer: 'users',
    status: 'no-writer-yet',
    label: 'Operator presence changed (roadmap 5.9)',
  },
  'staff.provisioning_requested': {
    subject: 'staff',
    writer: 'auth',
    status: 'no-writer-yet',
    label: 'Staff account requested through the provisioning API (roadmap 3.15)',
  },
  'staff.provisioning_rejected': {
    subject: 'staff',
    writer: 'auth',
    status: 'no-writer-yet',
    // Rejected calls are recorded too: a provisioning key that is being probed is exactly what the
    // trail must show (SEC-PV1).
    label: 'Provisioning call rejected (roadmap 3.15)',
  },
  'contact.lookup_performed': {
    subject: 'conversation',
    writer: 'chats',
    status: 'no-writer-yet',
    restricted: true,
    label: 'Customer looked up by contact value — HASHED, restricted (roadmap 6.7)',
  },
} as const satisfies Record<string, TransitionSpec>;

export type TransitionType = keyof typeof TRANSITION_TYPES;

const ALL: readonly string[] = Object.keys(TRANSITION_TYPES);

export const isTransitionType = (t: unknown): t is TransitionType =>
  typeof t === 'string' && ALL.includes(t);

/** Membership by status — the helper `catalogue.spec.ts` asserts against. */
export const transitionsWithStatus = (status: TransitionStatus): TransitionType[] =>
  (Object.entries(TRANSITION_TYPES) as [TransitionType, TransitionSpec][])
    .filter(([, spec]) => spec.status === status)
    .map(([type]) => type);

/** The SEC-26 exception set. Kept as its own export so a reader does not have to scan the map. */
export const RESTRICTED_TRANSITION_TYPES: readonly TransitionType[] = (
  Object.entries(TRANSITION_TYPES) as [TransitionType, TransitionSpec][]
)
  .filter(([, spec]) => spec.restricted === true)
  .map(([type]) => type);
