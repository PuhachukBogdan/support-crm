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

/**
 * W9 — the lookup's answer (ADR 0044 §4): enough to CONFIRM and attach, and nothing more. No card,
 * no contact echo, no list. `ambiguous` names nobody on purpose.
 */
export interface ContactLookupWire {
  matched: boolean;
  ambiguous: boolean;
  playerId: string;
  brandId: string;
}

/**
 * W10 — the player card's own read (`GET /players/:id`), AFTER the server's masking projection.
 *
 * ⚠️⚠️ **Absence here means TWO different things and the card must not guess between them.** The
 * gateway drops proto defaults (`''`, `false`, `0`, `[]`) AND withheld fields are structurally
 * absent — so a missing `vip` may be "not a VIP" or "your role may not see it". The card therefore
 * decides what to RENDER from the caller's role (session, render-only), never from emptiness; the
 * server decides what to SEND. Stated in the gateway's own wire.ts: *"a surface cannot use
 * emptiness to decide whether to render a field"*.
 */
export interface PlayerWire {
  playerId: string;
  accountId: string;
  brandId: string;
  brandIds?: string[];
  personId?: string;
  vip?: boolean;
  segment?: string;
  amNotes?: string;
  customAttributesJson?: string;
  preferencesJson?: string;
  portfolioJson?: string;
}

/**
 * W10 — the contact history (roadmap 4.13, `GET /players/:id/contact-summary`). Counts and
 * timestamps only: a contract test forbids any phone/email/handle field on this message, so no
 * contact VALUE can arrive through it. `''` on a timestamp means never.
 */
export interface ContactSummaryWire {
  lastInboundAt: string;
  lastOutboundAt: string;
  /** The later of the two — the "last contact" the card shows. `''` = never contacted. */
  lastContactAt: string;
  conversationCount: number;
  countsByStatus: { statusKey: string; conversationCount: number }[];
  channels: {
    channel: string;
    channelUnrecorded: boolean;
    lastInboundAt: string;
    lastOutboundAt: string;
    conversationCount: number;
  }[];
}

/** W9 — what detaching answers (0044 §5): the warning, quantified. */
export interface DetachWarningWire {
  detachedPlayerId: string;
  publicReplies: number;
  privateNotes: number;
}
