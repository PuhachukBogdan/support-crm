/**
 * The channel-capability matrix (feature 033, roadmap 6.6 — subpoint 2.1e).
 *
 * ── The question this answers ───────────────────────────────────────────────────────────────────
 * *"Can we send on this channel right now, and what kind of message?"* — asked before anything is
 * offered, so the product never renders an action guaranteed to fail. Roadmap 6.6 states the rule:
 * **render only genuinely available channels.**
 *
 * ── Why the platform limits are DATA and not `if` statements ─────────────────────────────────────
 * They are facts about somebody else's product, not decisions of ours:
 *
 *   • **Telegram** — a bot cannot message a user who has not started it.
 *   • **WhatsApp Business** — initiation only via an approved template, and outside a **24-hour**
 *     window free-form text is forbidden.
 *   • **Email** — none of this applies.
 *
 * They change when those platforms change, and they differ per platform *within* the messenger kind.
 * Written as branches they would be scattered across the send path, the future composer and the future
 * portfolio list, and the day WhatsApp moves to 48 hours somebody would have to find all three.
 *
 * ⚠️ **This is an ENFORCEMENT point, not a hint for the interface.** `canSend` is called by the server
 * before a delivery is enqueued (FR-006). A UI that merely hides a button leaves the path reachable by
 * anyone who calls the service directly, which is the whole reason authorization does not live in the
 * browser either.
 *
 * ── Scope, stated so the next reader does not think it unfinished ────────────────────────────────
 * The messenger row describes WhatsApp's constraints because they are the strictest of the family and
 * the matrix must be able to express them. **No messenger transport ships in the MVP** (`2.1i`, vendor
 * question `O1`), so `canSend` refuses it on `no_transport` before any of the finer rules are reached.
 * The finer rules are here so that connecting a messenger later is configuration plus an adapter, not
 * a redesign of what the product is allowed to ask.
 *
 * Pure data + pure helpers. No I/O.
 */
import { CHANNEL_KINDS, CHANNEL_KIND_SPECS, isChannelKind, type ChannelKind } from './kinds';

export interface ChannelCapability {
  /** May we open a conversation the customer did not start? */
  mayInitiate: boolean;
  /**
   * Hours after the customer's last message during which free-form text is allowed. `0` = no window
   * (email), i.e. always allowed — never "never allowed". A window is a restriction; its absence is
   * freedom, and reading `0` the other way would silently forbid every email reply.
   */
  replyWindowHours: number;
  supportsAttachments: boolean;
  /**
   * Initiating requires a pre-approved template rather than free text. Only meaningful together with
   * `mayInitiate`, and stated separately because "we may write first" and "we may write what we like"
   * are different permissions on the same platform.
   */
  templateRequiredToInitiate: boolean;
}

export const CHANNEL_CAPABILITIES: Readonly<Record<ChannelKind, ChannelCapability>> = {
  api: {
    // The widget session belongs to the customer: there is nowhere to deliver an unsolicited message,
    // because the transport is their open page and not an address we hold.
    mayInitiate: false,
    replyWindowHours: 0,
    supportsAttachments: true,
    templateRequiredToInitiate: false,
  },
  email: {
    // Unrestricted, which is exactly why the AM's outbound initiation (roadmap 6.6) ships on email and
    // waits on everything else.
    mayInitiate: true,
    replyWindowHours: 0,
    supportsAttachments: true,
    templateRequiredToInitiate: false,
  },
  messenger: {
    // WhatsApp Business, the strictest of the family. Telegram is stricter still on initiation (a bot
    // cannot start a conversation at all) — that is a per-PLATFORM refinement for when a messenger is
    // actually connected, and `no_transport` makes the distinction moot in the MVP.
    mayInitiate: true,
    replyWindowHours: 24,
    supportsAttachments: true,
    templateRequiredToInitiate: true,
  },
};

/** Why a send was refused. A CLASS, so it can be logged and shown without composing a sentence. */
export type CapabilityRefusal =
  /** The kind has no live transport in this build (messenger, in the MVP). */
  | 'no_transport'
  /** The kind cannot open a conversation the customer did not start. */
  | 'initiation_not_supported'
  /** Free-form text outside the platform's reply window; a template would be required. */
  | 'reply_window_expired'
  /** Initiating on this kind requires an approved template and none was given. */
  | 'template_required'
  /** Not a kind this product knows. */
  | 'unknown_channel_kind';

export interface SendContext {
  /**
   * Is this a reply to something the customer sent, rather than us writing first? The two are governed
   * by different platform rules, which is why the caller must say rather than the matrix guess.
   */
  initiating: boolean;
  /**
   * Hours since the customer's last inbound message. Only consulted when a window applies. `undefined`
   * with a window in force is treated as **outside** it: "we do not know how long ago they wrote" is
   * not evidence that it was recent.
   */
  hoursSinceLastInbound?: number;
  /** The caller is sending an approved template rather than free text. */
  usingApprovedTemplate?: boolean;
}

export type SendVerdict = { allowed: true } | { allowed: false; reason: CapabilityRefusal };

/**
 * The one function the send path and any future interface both ask.
 *
 * Order matters: transport availability is checked first, because a kind we cannot carry at all must
 * not be refused for a subtler reason that implies it would otherwise work.
 */
export function canSend(kind: string | null | undefined, ctx: SendContext): SendVerdict {
  if (!isChannelKind(kind)) return { allowed: false, reason: 'unknown_channel_kind' };
  // ⚠️ `outboundTransport`, NOT `liveTransport` — see the field's own note in `kinds.ts`. Reading the
  // latter here allowed a reply on an API-channel ticket, whose transport back is the customer's open page
  // and not an address we hold. Feature 033's US4 spec caught it; the fix was to stop making one boolean
  // mean two facts.
  if (!CHANNEL_KIND_SPECS[kind].outboundTransport) return { allowed: false, reason: 'no_transport' };

  const cap = CHANNEL_CAPABILITIES[kind];

  if (ctx.initiating) {
    if (!cap.mayInitiate) return { allowed: false, reason: 'initiation_not_supported' };
    if (cap.templateRequiredToInitiate && !ctx.usingApprovedTemplate) {
      return { allowed: false, reason: 'template_required' };
    }
    // Initiating is never inside a reply window — there is no inbound message to measure from.
    return { allowed: true };
  }

  if (cap.replyWindowHours > 0 && !ctx.usingApprovedTemplate) {
    const hours = ctx.hoursSinceLastInbound;
    if (hours === undefined || hours > cap.replyWindowHours) {
      return { allowed: false, reason: 'reply_window_expired' };
    }
  }

  return { allowed: true };
}

/** The whole matrix, for the read RPC the Inbox and analytics will stand on. */
export function listChannelCapabilities(): ReadonlyArray<
  ChannelCapability & { kind: ChannelKind; liveTransport: boolean; outboundTransport: boolean }
> {
  return CHANNEL_KINDS.map((kind) => ({
    kind,
    liveTransport: CHANNEL_KIND_SPECS[kind].liveTransport,
    // ⭐ Both directions, because they differ for `api` and a consumer deciding whether to offer a reply
    // box needs the OUT one — not the "is this kind connected" one (see `kinds.ts`).
    outboundTransport: CHANNEL_KIND_SPECS[kind].outboundTransport,
    ...CHANNEL_CAPABILITIES[kind],
  }));
}
