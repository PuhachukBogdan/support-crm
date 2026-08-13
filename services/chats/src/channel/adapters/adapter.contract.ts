import type { ChannelKind } from '@crm/common';

/**
 * The channel adapter contract (feature 033, subpoint 2.1e — FR-004).
 *
 * ── What this exists to prevent ─────────────────────────────────────────────────────────────────
 * Two channels ship in this feature and a third is declared. Without one contract, the API channel's
 * intake and the email channel's intake become two code paths that happen to write the same tables —
 * and the day a third arrives, whichever of the two it was copied from becomes the accidental
 * specification. The Inbox filter, the analytics split and every future channel stand on the *kind*;
 * this is what they stand on behaviourally.
 *
 * ── The three questions, and why exactly these three ────────────────────────────────────────────
 * They are the three things the product must know about a channel it did not write:
 *
 *  1. **`normalise`** — turn somebody else's payload into our ticket and message. Every channel's
 *     format is foreign; ours is not negotiable.
 *  2. **`send` or the honest refusal** — a channel that cannot carry a message must be able to *say
 *     so*, and be believed, rather than throw when tried. That is what makes `messenger` shippable as
 *     a contract with no transport (`2.1i`), and it is why the return type is a verdict rather than a
 *     void promise.
 *  3. **`supportsAttachments`** — whether files can travel at all, asked before one is offered.
 *
 * ── What is deliberately NOT on this interface ──────────────────────────────────────────────────
 * **Identity resolution, threading, status selection, routing, deduplication.** Every one of those is
 * the same for every channel and belongs to the intake service, not to an adapter. An adapter that
 * could resolve a player would eventually resolve one differently from its sibling, and the difference
 * would surface as one channel attaching conversations to the wrong customer. The adapter's whole job
 * is to stop the outside world's shape at the boundary.
 *
 * **Signature verification** is also absent, for a subtler reason: it is per-channel *configuration*
 * (a shared secret), not per-*kind* behaviour. The email channel authenticates by holding the mailbox;
 * the API channel by HMAC. Putting it here would force every adapter to answer a question only one of
 * them has.
 */

/** A file that arrived with an inbound message, before it becomes an upload. */
export interface NormalisedAttachment {
  filename: string;
  declaredContentType: string;
  content: Buffer;
}

/**
 * One inbound message, in our shape.
 *
 * ⚠️ `externalEventId` is REQUIRED and has no default. A delivery from which no stable identifier can
 * be derived is refused (FR-014) rather than accepted with a generated one — a generated id makes every
 * replay look new, which is the exact failure at-most-once intake exists to prevent. Making the field
 * non-optional means an adapter cannot forget to answer.
 */
export interface NormalisedInbound {
  /** Stable per channel. The dedup constraint stands on `(channel_id, externalEventId)`. */
  externalEventId: string;
  /**
   * The message's own identifier on its channel, when it has one — an email's `Message-ID`. Stored on
   * the message so a reply weeks later can be threaded to it. `undefined` where the channel has no such
   * concept (the API channel today).
   */
  externalMessageId?: string;
  /** Threading references, most-recent-first where the channel provides several. */
  inReplyTo?: string;
  references?: string[];
  /**
   * The identifier the channel carries for whoever wrote — an email address, a platform player id.
   *
   * ⚠️ The **class** is stated separately from the value because the class is what may be recorded and
   * the value is not (ADR 0044 §4). An adapter that returned only a string would force the intake path
   * to guess which kind it was looking at, and a guess about identity is how a phone number gets
   * matched against email hashes.
   */
  identity?: { kind: 'email' | 'phone' | 'player_id'; value: string };
  /**
   * The title the source itself gave. `undefined` means the source gave none — which is different from
   * `''` and must stay different: an empty subject leaves our own derivation window open (FR-028),
   * whereas a stored empty string would be a title that is blank forever.
   */
  subject?: string;
  body: string;
  attachments?: NormalisedAttachment[];
  /** When the source says it was sent. Advisory only — never used as an ordering key we depend on. */
  sentAt?: Date;
}

/** Why an adapter refused to normalise. A CLASS, never a sentence built from the payload. */
export type NormaliseRefusal =
  /** No stable event identifier could be derived (FR-014). */
  | 'no_event_id'
  /** The payload could not be read at all — malformed, truncated, wrong shape. */
  | 'unparseable'
  /** Recognised as our own mail coming back: an auto-reply, a bounce, a loop (FR-033). */
  | 'loop'
  /** Readable, but missing something a ticket requires. */
  | 'incomplete';

export type NormaliseResult =
  | { ok: true; message: NormalisedInbound }
  | { ok: false; refusal: NormaliseRefusal };

/** An outbound message an adapter is asked to carry. */
export interface OutboundPayload {
  to: string;
  subject: string;
  body: string;
  /** Our identifier for this message, so the reply to it can be threaded back. */
  externalMessageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: NormalisedAttachment[];
}

/**
 * Why an adapter refused to send. Deliberately narrow: capability refusals
 * (`no_transport`, `reply_window_expired`, …) are decided by `canSend` in `libs/common` BEFORE an
 * adapter is reached, so the two vocabularies do not overlap and neither has to know the other.
 */
export type SendRefusal =
  /** This kind has no transport in this build. The adapter says so; it does not throw. */
  | 'not_supported'
  /** The transport was reached and refused, or could not be reached. Detail is a mail error class. */
  | 'transport_failed';

export type AdapterSendResult = { ok: true } | { ok: false; refusal: SendRefusal; detail?: string };

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Whether files can travel on this kind at all. Asked before one is offered. */
  readonly supportsAttachments: boolean;
  /**
   * Somebody else's payload → our shape. Pure: no database, no network, no clock beyond what the
   * payload carries. That is what makes every refusal in `NormaliseRefusal` unit-testable without a
   * mailbox or a webhook.
   */
  normalise(raw: Buffer | Record<string, unknown>): NormaliseResult;
  /**
   * Carry a message out, **or state that this channel cannot**.
   *
   * ⚠️ A kind with no transport returns `{ ok: false, refusal: 'not_supported' }`. It does not throw and
   * it does not silently succeed. Those are the two failures FR-007 names: a crash tells the caller the
   * product is broken when it is merely incapable, and a silent success loses a customer's reply with
   * no symptom until they ask why nobody answered.
   */
  send(payload: OutboundPayload): Promise<AdapterSendResult>;
}
