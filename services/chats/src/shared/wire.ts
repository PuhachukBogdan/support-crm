/**
 * Wire <-> storage mappers for the chats contract (feature 012). Keeps the proto enum names
 * (enums:String) and the DB scalar values in one place so controllers stay thin. `MessageKind` is
 * DERIVED from `author_type` + `private` (research R5) — storage keeps those two fields, not a kind.
 */

// ── Conversation status ───────────────────────────────────────────────────────
export type DbStatus = 'open' | 'pending' | 'resolved' | 'snoozed';

const STATUS_TO_WIRE: Record<DbStatus, string> = {
  open: 'CONVERSATION_STATUS_OPEN',
  pending: 'CONVERSATION_STATUS_PENDING',
  resolved: 'CONVERSATION_STATUS_RESOLVED',
  snoozed: 'CONVERSATION_STATUS_SNOOZED',
};
const WIRE_TO_STATUS: Record<string, DbStatus> = {
  CONVERSATION_STATUS_OPEN: 'open',
  CONVERSATION_STATUS_PENDING: 'pending',
  CONVERSATION_STATUS_RESOLVED: 'resolved',
  CONVERSATION_STATUS_SNOOZED: 'snoozed',
};

export function statusToWire(db: string): string {
  return STATUS_TO_WIRE[db as DbStatus] ?? 'CONVERSATION_STATUS_UNSPECIFIED';
}
/** undefined = no filter / not a concrete status (UNSPECIFIED or unknown). */
export function wireToStatus(wire: string | undefined): DbStatus | undefined {
  if (!wire || wire === 'CONVERSATION_STATUS_UNSPECIFIED') return undefined;
  return WIRE_TO_STATUS[wire];
}
export function isValidStatusWire(wire: string | undefined): boolean {
  return !!wire && wire !== 'CONVERSATION_STATUS_UNSPECIFIED' && wire in WIRE_TO_STATUS;
}

// ── SLA outcome (feature 014; moved HERE by feature 017) ──────────────────────
/**
 * The SLA filter values, mapped to the stored outcome scalar.
 *
 * ⚠️ This lived as a private constant inside `conversation.grpc.controller.ts` until the export needed
 * the same filter, and Track B showed what a second copy costs: the export edge had grown its own
 * vocabulary (`pending` where the list says `running`), so the two "identical" filter sets had already
 * drifted — inside the file whose header promises they are the same. One map, one place.
 */
const WIRE_TO_SLA_OUTCOME: Record<string, string> = {
  SLA_OUTCOME_RUNNING: 'running',
  SLA_OUTCOME_MET: 'met',
  SLA_OUTCOME_BREACHED: 'breached',
};

/** `undefined` = no filter (absent or UNSPECIFIED). `null` = a value the wire does not define. */
/**
 * Feature 029 — the conversation list's order.
 *
 * `undefined` = "not asked for, use the default"; `null` = "asked for something that does not exist",
 * which the caller must refuse rather than coerce. Same three-state shape as `wireToSlaOutcome` below,
 * and for the same reason: feature 012's live defect was a silently coerced unknown value.
 */
const WIRE_TO_CONVERSATION_ORDER: Record<string, string> = {
  CONVERSATION_ORDER_UPDATED_DESC: 'updated_desc',
  CONVERSATION_ORDER_UPDATED_ASC: 'updated_asc',
  // Feature 031 (FR-019): the urgency rank. See `conversation/urgency.ts`.
  CONVERSATION_ORDER_URGENCY_DESC: 'urgency_desc',
};

export function wireToConversationOrder(wire: string | undefined): string | undefined | null {
  if (!wire || wire === 'CONVERSATION_ORDER_UNSPECIFIED') return undefined;
  return WIRE_TO_CONVERSATION_ORDER[wire] ?? null;
}

export function wireToSlaOutcome(wire: string | undefined): string | undefined | null {
  if (!wire || wire === 'SLA_OUTCOME_UNSPECIFIED') return undefined;
  return WIRE_TO_SLA_OUTCOME[wire] ?? null;
}

// ── Conversation priority (feature 014) ──────────────────────────────────────
/**
 * The closed priority set a **write** may set. `Conversation.priority` is a free-form column and the
 * 012 list *filter* stays free-form (narrowing it would change existing behaviour for no reason);
 * this allow-list exists because feature 014 introduced the first path that WRITES a priority from a
 * stored definition — a macro or automation action. An unrecognised value there must be refused, not
 * persisted, or a rule could park a priority nothing else in the product understands.
 *
 * `'*'` is deliberately absent: it is the SLA-policy "any" sentinel (research R7) and must never be
 * storable as a real priority.
 */
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function isValidPriority(value: string | undefined): value is Priority {
  return !!value && (PRIORITIES as readonly string[]).includes(value);
}

// ── Message kind (derived) ────────────────────────────────────────────────────
export function kindFromMessage(authorType: string, isPrivate: boolean): string {
  if (authorType === 'player') return 'MESSAGE_KIND_INCOMING_CUSTOMER';
  if (authorType === 'system') return 'MESSAGE_KIND_SYSTEM';
  return isPrivate ? 'MESSAGE_KIND_PRIVATE_NOTE' : 'MESSAGE_KIND_PUBLIC_REPLY';
}

// ── Thread projection ─────────────────────────────────────────────────────────
export type Projection = 'staff' | 'customer';
export function projectionFromWire(wire: string | undefined): Projection {
  return wire === 'THREAD_PROJECTION_CUSTOMER' ? 'customer' : 'staff';
}

// ── DTO shapes (rows the repositories return) ─────────────────────────────────
export interface ConversationSummaryRow {
  id: string;
  brand_id: string;
  player_id: string | null;
  status: string;
  priority: string | null;
  assignee_operator_id: string | null;
  channel: string | null;
  created_at: Date;
  updated_at: Date;
  /** Feature 023 (roadmap 4.18): the human-readable title. Null while the window is open. */
  subject: string | null;
}
export interface ConversationDetailRow extends ConversationSummaryRow {
  reference: string | null;
  category: string | null;
  sub_category: string | null;
  classified_by: string | null;
  /** `auto` | `manual`; null while the derivation window is still open (feature 023). */
  subject_source: string | null;
  /**
   * Feature 024 (roadmap 5.3): which DESK the work was routed to. Soft ref to `auth.Group.id`, never
   * joined. Null for everything routed the old way, and for everything that predates the column.
   */
  routed_group_id: string | null;
}

export function toSummaryWire(r: ConversationSummaryRow) {
  return {
    id: r.id,
    brandId: r.brand_id,
    playerId: r.player_id ?? '',
    status: statusToWire(r.status),
    priority: r.priority ?? '',
    assigneeOperatorId: r.assignee_operator_id ?? '',
    channel: r.channel ?? '',
    lastActivityAt: r.updated_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    // Feature 023: the reason this whole feature exists — a scannable list.
    subject: r.subject ?? '',
  };
}
export interface MessageRow {
  id: string;
  conversation_id: string;
  author_type: string;
  author_id: string | null;
  body: string;
  private: boolean;
  mentions: string[];
  created_at: Date;
  /**
   * Feature 016 — the message's attachment links, loaded THROUGH the message query (never by a
   * separate fetch). That is what makes the SEC-13 private-note exclusion cover attachments without
   * re-implementing it: a private note is not in the customer result set, so neither are its rows.
   */
  attachments?: MessageAttachmentRow[];
}

export interface MessageAttachmentRow {
  upload_id: string;
  position: number;
}

/**
 * Rendering metadata for one attachment, fetched from `users` per thread page (feature 016).
 * Deliberately NOT denormalized into chats_db — that keeps the PII-capable `display_name` in
 * exactly one database.
 */
export interface AttachmentWire {
  uploadId: string;
  contentType: string;
  byteSize: number;
  displayName: string;
  hasDerivative: boolean;
}

/**
 * Map a stored message to the wire shape. `kind` is derived (R5). NOTE: the CUSTOMER projection
 * excludes private-note rows at the QUERY (never loaded), so this mapper never serialises a private
 * note into a customer payload — the SEC-13 guarantee is structural, not a field here (R4/SC-002).
 *
 * Feature 016: `attachments` is keyed off the row's OWN attachment links, so a message the query did
 * not return contributes nothing — not its body, not its ids. `describedBy` supplies the metadata
 * that lives in users_db; an id with no description (not visible to this caller) is dropped rather
 * than emitted half-filled, because a half-filled attachment renders as a broken one.
 */
export function toMessageWire(m: MessageRow, describedBy?: Map<string, AttachmentWire>) {
  const links = m.attachments ?? [];
  const attachments =
    links.length > 0 && describedBy
      ? links
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((l) => describedBy.get(l.upload_id))
          .filter((a): a is AttachmentWire => !!a)
      : [];
  return {
    id: m.id,
    conversationId: m.conversation_id,
    kind: kindFromMessage(m.author_type, m.private),
    authorId: m.author_id ?? '',
    body: m.body,
    mentions: m.mentions ?? [],
    createdAt: m.created_at.toISOString(),
    attachments,
  };
}

export function toDetailWire(r: ConversationDetailRow) {
  return {
    id: r.id,
    brandId: r.brand_id,
    playerId: r.player_id ?? '',
    status: statusToWire(r.status),
    priority: r.priority ?? '',
    assigneeOperatorId: r.assignee_operator_id ?? '',
    channel: r.channel ?? '',
    reference: r.reference ?? '',
    category: r.category ?? '',
    subCategory: r.sub_category ?? '',
    classifiedBy: r.classified_by ?? '',
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    subject: r.subject ?? '',
    subjectSource: r.subject_source ?? '',
    routedGroupId: r.routed_group_id ?? '',
  };
}
