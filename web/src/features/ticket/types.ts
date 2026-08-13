/**
 * The ticket window's wire shapes (W7, roadmap 9.3).
 *
 * ⚠️ Mirrors the gateway's REST DTOs (`services/gateway/src/chats/…`), which mirror
 * `libs/proto/crm/chats/v1` — the contract lives there, not here. Absent values arrive as `''`,
 * never null, and the transport passes records through untouched: an empty string here is the
 * server's word (possibly a withheld field), and inventing a default would reconstruct the
 * disclosure it refused to make.
 */

/** The detail read (`GET /conversations/:id`) — the summary's fields plus the window's own. */
export interface ConversationDetail {
  id: string;
  brandId: string;
  playerId: string;
  statusKey: string;
  statusCategory: string;
  priority: string;
  assigneeOperatorId: string;
  channel: string;
  reference: string;
  category: string;
  subCategory: string;
  classifiedBy: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  /**
   * 4.18 — how the subject came to be: `''` = the derivation window is still OPEN · `auto` = the
   * server derived it · `manual` = a person typed it · `source` = the channel named it (email
   * Subject). Any non-empty value means FROZEN against automated writers.
   */
  subjectSource: string;
  routedGroupId: string;
  /** `identified` | `unidentified` — W9 builds the attach flow for the second. */
  identityState: string;
  continuesConversationId: string;
}

/**
 * A thread entry (`GET /conversations/:id/thread`, staff projection). `kind` is DERIVED server-side
 * from author_type + private — the four values below are the whole vocabulary.
 */
export type MessageKind =
  | 'MESSAGE_KIND_INCOMING_CUSTOMER'
  | 'MESSAGE_KIND_PUBLIC_REPLY'
  | 'MESSAGE_KIND_PRIVATE_NOTE'
  | 'MESSAGE_KIND_SYSTEM';

export interface MessageAttachment {
  uploadId: string;
  contentType: string;
  byteSize: number;
  displayName: string;
  /** True when a 256px derivative exists (images). The thumb URL 404s when it does not. */
  hasDerivative: boolean;
}

export interface ThreadMessage {
  id: string;
  conversationId: string;
  kind: string;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: string;
  attachments: MessageAttachment[];
}

/** An account label (`GET /labels`) — tags, in the operator's vocabulary. */
export interface LabelWire {
  id: string;
  name: string;
  color?: string;
}

/** W8 — a macro (`GET /macros`): a named bundle of actions the service applies all-or-nothing. */
export interface MacroWire {
  id: string;
  name: string;
  actions: { type: string; value?: string }[];
}

/** W8 — a canned response (`GET /canned-responses`): text a lead wrote for agents to insert. */
export interface CannedResponseWire {
  id: string;
  name: string;
  body: string;
}
