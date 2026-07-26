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
}
export interface ConversationDetailRow extends ConversationSummaryRow {
  reference: string | null;
  category: string | null;
  sub_category: string | null;
  classified_by: string | null;
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
}

/**
 * Map a stored message to the wire shape. `kind` is derived (R5). NOTE: the CUSTOMER projection
 * excludes private-note rows at the QUERY (never loaded), so this mapper never serialises a private
 * note into a customer payload — the SEC-13 guarantee is structural, not a field here (R4/SC-002).
 */
export function toMessageWire(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    kind: kindFromMessage(m.author_type, m.private),
    authorId: m.author_id ?? '',
    body: m.body,
    mentions: m.mentions ?? [],
    createdAt: m.created_at.toISOString(),
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
  };
}
