import { BadRequestException } from '@nestjs/common';

/**
 * REST → proto enum mapping for the chats edge, **fail-closed**.
 *
 * Found by feature-012 Track B (live, 2026-07-26): the original mappers silently coerced any
 * unrecognized value to a default — `kind` fell through to **PUBLIC_REPLY**, so a client posting
 * `{"kind":"private_note"}` (a plausible spelling of `note`) published an intended internal note
 * **to the customer**. That is the SEC-13 failure mode reached by an ordinary client typo, and no
 * Track-A spec could see it because specs pass canonical values.
 *
 * Rule: an **unknown** value is a client error (400), never a silently-chosen default. Only an
 * absent/empty value takes the documented default.
 */

const reject = (field: string, value: string, allowed: readonly string[]): never => {
  // Echoes the offending field + the allow-list, never anything else about the request.
  throw new BadRequestException(`invalid ${field}: expected one of ${allowed.join(' | ')}`);
};

const CONVERSATION_STATUS: Record<string, string> = {
  open: 'CONVERSATION_STATUS_OPEN',
  pending: 'CONVERSATION_STATUS_PENDING',
  resolved: 'CONVERSATION_STATUS_RESOLVED',
  snoozed: 'CONVERSATION_STATUS_SNOOZED',
};

/** Absent/empty → UNSPECIFIED (no status filter). Unknown → 400. */
export function toStatusWire(status?: string): string {
  if (!status) return 'CONVERSATION_STATUS_UNSPECIFIED';
  return CONVERSATION_STATUS[status] ?? reject('status', status, Object.keys(CONVERSATION_STATUS));
}

/** A status *mutation* must name a concrete status — empty is a client error, not "unspecified". */
export function toStatusWireRequired(status?: string): string {
  if (!status) return reject('status', '', Object.keys(CONVERSATION_STATUS));
  return CONVERSATION_STATUS[status] ?? reject('status', status, Object.keys(CONVERSATION_STATUS));
}

const MESSAGE_KIND: Record<string, string> = {
  reply: 'MESSAGE_KIND_PUBLIC_REPLY',
  note: 'MESSAGE_KIND_PRIVATE_NOTE',
};

/**
 * Absent/empty → PUBLIC_REPLY (the documented default). Unknown → 400 — the whole point of this
 * module: never resolve an unrecognized kind to a customer-visible message.
 */
export function toKindWire(kind?: string): string {
  if (!kind) return 'MESSAGE_KIND_PUBLIC_REPLY';
  return MESSAGE_KIND[kind] ?? reject('kind', kind, Object.keys(MESSAGE_KIND));
}

const MACRO_ACTION_TYPE: Record<string, string> = {
  set_status: 'MACRO_ACTION_TYPE_SET_STATUS',
  add_label: 'MACRO_ACTION_TYPE_ADD_LABEL',
  assign: 'MACRO_ACTION_TYPE_ASSIGN',
};

/**
 * Macro action type (feature 013). **Always required** — there is no sensible default for "what
 * should this action do", and guessing is exactly the failure this module exists to prevent: an
 * unknown action silently resolving to a real mutation. Unknown/absent → 400.
 */
export function toMacroActionTypeWire(type?: string): string {
  if (!type) return reject('action type', '', Object.keys(MACRO_ACTION_TYPE));
  return MACRO_ACTION_TYPE[type] ?? reject('action type', type, Object.keys(MACRO_ACTION_TYPE));
}

/** The action list on a DefineMacro request: each action validated, an empty list rejected. */
export function toMacroActionsWire(
  actions?: { type?: string; value?: string }[],
): { type: string; value: string }[] {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new BadRequestException('invalid actions: expected a non-empty array of {type, value}');
  }
  return actions.map((a) => {
    const type = toMacroActionTypeWire(a?.type);
    const raw = (a?.value ?? '').trim();
    if (!raw) throw new BadRequestException('invalid action value: must not be empty');
    // A SET_STATUS action's value IS a conversation status — run it through the same allow-list the
    // status endpoints use (and store the wire name), so a macro can never hold an unknown status.
    const value = type === 'MACRO_ACTION_TYPE_SET_STATUS' ? toStatusWireRequired(raw) : raw;
    return { type, value };
  });
}

const THREAD_PROJECTION: Record<string, string> = {
  staff: 'THREAD_PROJECTION_STAFF',
  customer: 'THREAD_PROJECTION_CUSTOMER',
};

/** Absent/empty → STAFF. Unknown → 400 (a mistyped projection must not silently pick one). */
export function toProjectionWire(projection?: string): string {
  if (!projection) return 'THREAD_PROJECTION_STAFF';
  return THREAD_PROJECTION[projection] ?? reject('projection', projection, Object.keys(THREAD_PROJECTION));
}
