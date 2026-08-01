import { isTransitionType, type TransitionType } from './catalogue';

/**
 * The per-type payload allow-list (feature 023, roadmap 4.8a — FR-007 / Principle IV / SEC-26).
 *
 * ── Why an allow-list and not a deny-list of bad words ───────────────────────────────────────────
 * A deny-list is a guess about what someone will add next. An allow-list makes the wrong thing
 * **inexpressible**: an unknown key is refused at write time, so "somebody adds `body` to the payload
 * one day" fails a test instead of quietly putting customer text into an append-only store. This is
 * the technique feature 015 used for the audit trail, and it is here for the same reason.
 *
 * ⚠️ The sharpest case is the SUBJECT. `conversation.subject_set` is exactly the type tempted to carry
 * the title — and a title is the CUSTOMER's own words. The type records THAT a human named the
 * conversation, never WHAT they wrote; the current value lives on the conversation row.
 *
 * Values must be ids or enum members: flat, bounded, no nesting. Even an allow-listed key must not
 * become a smuggling channel for a paragraph.
 *
 * Pure. No I/O.
 */

export class TransitionPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionPayloadError';
  }
}

/** The longest an id or enum member may be. Well above any of ours, far below a sentence. */
const MAX_VALUE_LENGTH = 128;

/** Allowed keys per type. A type absent from here accepts NO payload at all. */
const ALLOWED_KEYS: Partial<Record<TransitionType, readonly string[]>> = {
  'conversation.status_changed': ['from', 'to'],
  'conversation.assigned': ['from', 'to'],
  'conversation.first_public_reply': ['messageId'],
  // ⚠️ `source` ONLY (`auto` | `manual`). Not `subject`, not `title`, not `text` — see the header.
  'conversation.subject_set': ['source'],
  'conversation.released': ['reasonCode'],
  'conversation.player_attached': ['playerId'],
  'conversation.player_detached': ['playerId'],
  'escalation.status_changed': ['from', 'to'],
  'escalation.waiting_changed': ['from', 'to'],
  'operator.presence_changed': ['from', 'to', 'cause'],
  'staff.provisioning_requested': ['hrEmployeeId', 'outcome'],
  'staff.provisioning_rejected': ['reasonCode'],
  // The SEC-26 exception: a one-way hash plus the KIND of value searched. Never the value.
  'contact.lookup_performed': ['valueHash', 'valueKind', 'matched'],
};

/**
 * Validate a payload against its type, or throw.
 *
 * A payload is REQUIRED for every type that declares keys — passing `undefined` where the type
 * expects `{from,to}` is a caller bug, not an empty record, and silently accepting it would produce
 * transitions that cannot answer the question they exist for.
 */
export function assertTransitionPayload(type: string, payload: unknown): void {
  if (!isTransitionType(type)) {
    throw new TransitionPayloadError(`unknown transition type: ${sanitizeType(type)}`);
  }

  const allowed = ALLOWED_KEYS[type];

  if (!allowed || allowed.length === 0) {
    if (payload !== undefined && payload !== null) {
      throw new TransitionPayloadError(`transition ${type} accepts no payload`);
    }
    return;
  }

  if (payload === undefined || payload === null) {
    throw new TransitionPayloadError(`transition ${type} requires a payload`);
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TransitionPayloadError(`transition ${type}: payload must be a flat object`);
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      // The message names the KEY (a catalogue literal or caller-chosen identifier), never the value.
      throw new TransitionPayloadError(
        `transition ${type}: key not allowed: ${sanitizeType(key)} (allowed: ${allowed.join(', ')})`,
      );
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean' || typeof value === 'number') continue;
    if (typeof value !== 'string') {
      throw new TransitionPayloadError(
        `transition ${type}: ${key} must be an id, enum, number or boolean — not ${typeof value}`,
      );
    }
    if (value.length > MAX_VALUE_LENGTH) {
      // Length only — the offending value is never echoed back into a message or a log.
      throw new TransitionPayloadError(
        `transition ${type}: ${key} exceeds ${MAX_VALUE_LENGTH} characters (${value.length})`,
      );
    }
  }
}

/** Keep an unknown, caller-supplied token out of messages and logs (the feature 021 lesson). */
const sanitizeType = (t: unknown): string =>
  typeof t === 'string' ? `<${t.length} chars>` : `<${typeof t}>`;
