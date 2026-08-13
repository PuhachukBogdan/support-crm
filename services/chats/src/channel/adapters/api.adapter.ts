import { Injectable } from '@nestjs/common';
import type { ChannelKind } from '@crm/common';
import type {
  ChannelAdapter,
  NormaliseResult,
  NormalisedInbound,
  OutboundPayload,
  AdapterSendResult,
} from './adapter.contract';

/**
 * The API channel adapter (feature 033, roadmap 6.1 — subpoint 2.1a).
 *
 * Turns the operator's own LLM-widget payload into our ticket and message. **Their format, our shape** —
 * and their format is not ours to dictate, which is why this file is the only place that knows it.
 *
 * ── The permissive and the strict parts, chosen deliberately ─────────────────────────────────────
 * *Permissive* about shape: several field spellings are accepted for the same fact, because a provider
 * renames things and a rename should not lose a customer's message. Unmodelled fields are ignored
 * outright (FR-015) — a widget that adds telemetry must not start failing.
 *
 * *Strict* about exactly two things:
 *   1. **The event id** (FR-014). No stable identifier ⇒ **refused**, never accepted with a generated
 *      one. A generated id makes every replay look new, which is the precise failure at-most-once intake
 *      exists to prevent; and a silent pass is the most expensive class of defect in this project.
 *   2. **The body.** A ticket with no words is not a ticket. An empty one would occupy an agent, appear
 *      in the queue and say nothing.
 *
 * ── What this adapter deliberately does NOT do ──────────────────────────────────────────────────
 * Resolve identity, thread, choose a status, route, deduplicate, or verify the signature. All of those
 * are the same for every channel and belong to the intake service; an adapter that resolved a player
 * would eventually resolve one differently from its sibling. See `adapter.contract.ts`.
 *
 * ⚠️ **It also never reads a brand from the payload.** There is no code here that could: the brand comes
 * from the channel row the credential named (FR-011). A `brand` field in a body is data, not authority,
 * and this adapter drops it with every other unmodelled field.
 */
@Injectable()
export class ApiChannelAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'api';
  readonly supportsAttachments = true;

  normalise(raw: Buffer | Record<string, unknown>): NormaliseResult {
    let payload: Record<string, unknown>;
    try {
      payload = Buffer.isBuffer(raw)
        ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>)
        : raw;
    } catch {
      // Nothing of the payload is logged or echoed — it is a stranger's input and may carry anything.
      return { ok: false, refusal: 'unparseable' };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, refusal: 'unparseable' };
    }

    const externalEventId = firstString(payload, ['event_id', 'eventId', 'id', 'delivery_id']);
    if (!externalEventId) return { ok: false, refusal: 'no_event_id' };

    const message = asObject(payload.message) ?? asObject(payload.data) ?? payload;
    const body = firstString(message, ['text', 'body', 'content', 'message']);
    if (!body) return { ok: false, refusal: 'incomplete' };

    const conversation = asObject(payload.conversation) ?? {};
    const author = asObject(payload.author) ?? asObject(payload.user) ?? asObject(payload.player) ?? {};

    const normalised: NormalisedInbound = {
      externalEventId,
      // The widget's own conversation id, when it has one: it is what makes a second message from the
      // same session join the ticket the first one created rather than opening another.
      externalMessageId: firstString(conversation, ['external_id', 'externalId', 'id']),
      body,
      // The widget names its player with the platform id — the top of ADR 0044's resolution ladder, where
      // no resolution is needed at all because the id IS the identity.
      identity: identityOf(author, payload),
      // ⚠️ Deliberately NOT read from the payload: `subject`. The widget's first line is exactly what
      // feature 023 exists to stop being a title (their lists read as "привет" and "???"), so the
      // derivation window is left open rather than filled with whatever the customer typed first.
      sentAt: dateOf(firstString(payload, ['sent_at', 'sentAt', 'timestamp'])),
      attachments: [],
    };

    return { ok: true, message: normalised };
  }

  /**
   * The API channel cannot carry an outbound message in the MVP.
   *
   * ⚠️ It **says so** rather than throwing, which is the contract's whole point. The widget session is the
   * customer's open page: there is no address to deliver to, so this is a real "cannot", not an unbuilt
   * feature. The capability matrix says the same thing one layer up (`mayInitiate: false`), and the send
   * path refuses there before reaching here — this is the backstop for a caller that skipped it.
   */
  async send(payload: OutboundPayload): Promise<AdapterSendResult> {
    // The parameter is named rather than underscored so the signature reads as the contract's, and it is
    // deliberately referenced in nothing: there is no transport to hand it to.
    void payload;
    return { ok: false, refusal: 'not_supported' };
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** First key present as a non-empty string. Several spellings, one fact. */
function firstString(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/**
 * What the payload says about who wrote.
 *
 * ⚠️ The **class** is stated alongside the value, never inferred later. A caller handed a bare string
 * would have to guess whether it was an address or a platform id, and a guess about identity is how a
 * phone number gets matched against email hashes.
 *
 * Order matters: a platform id is the strongest signal we can get (it needs no resolution at all), so it
 * wins over an address when a payload carries both.
 */
function identityOf(
  author: Record<string, unknown>,
  payload: Record<string, unknown>,
): NormalisedInbound['identity'] {
  const playerId = firstString(author, ['player_id', 'playerId', 'id']) ?? firstString(payload, ['player_id', 'playerId']);
  if (playerId) return { kind: 'player_id', value: playerId };
  const email = firstString(author, ['email', 'email_address']);
  if (email) return { kind: 'email', value: email };
  const phone = firstString(author, ['phone', 'phone_number', 'msisdn']);
  if (phone) return { kind: 'phone', value: phone };
  // Nothing usable. The ticket is created UNIDENTIFIED and complete — identity never blocks intake.
  return undefined;
}

function dateOf(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
