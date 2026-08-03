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

/**
 * The longest title a person may set (feature 023, roadmap 4.18).
 *
 * ⚠️ Deliberately the SAME number as the derivation's cap, and deliberately DUPLICATED rather than
 * imported: the gateway does not depend on a service's internals, and `@crm/common` is for things both
 * tiers own. The pin below asserts the two agree, so a change to one fails the build rather than
 * producing an edge that rejects titles the service would have accepted.
 */
export const MAX_SUBJECT_LENGTH = 120;

/**
 * A human-set conversation title.
 *
 * **Refused, never truncated.** A silently shortened title is a title the author did not write, and
 * they have no way to tell — the same fail-closed stance every parser in this file takes, for the same
 * reason. Empty is refused too: clearing a title would freeze the conversation at nothing, because the
 * automated writers may never fill a `manual` field again.
 *
 * Whitespace is COLLAPSED, not rejected — a pasted line break is a formatting accident, not an intent
 * to send something invalid, and the owning service normalises identically.
 */
export function toSubjectWire(subject?: string): string {
  const value = (subject ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) throw new BadRequestException('subject is required');
  if (value.length > MAX_SUBJECT_LENGTH) {
    // LENGTH only. Echoing the value would put a human's words into a client log (SEC-26's spirit).
    throw new BadRequestException(`subject must be at most ${MAX_SUBJECT_LENGTH} characters`);
  }
  return value;
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
  // Feature 014: the vocabulary is shared by macros and automation rules.
  set_priority: 'MACRO_ACTION_TYPE_SET_PRIORITY',
};

/** The closed priority set an action may SET (the list filter stays free-form — see chats wire). */
const PRIORITIES = ['low', 'normal', 'high'] as const;

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
    if (type === 'MACRO_ACTION_TYPE_SET_PRIORITY' && !(PRIORITIES as readonly string[]).includes(raw)) {
      reject('action priority', raw, PRIORITIES as unknown as string[]);
    }
    const value = type === 'MACRO_ACTION_TYPE_SET_STATUS' ? toStatusWireRequired(raw) : raw;
    return { type, value };
  });
}

// ── Feature 014: automation rules + the SLA filter ────────────────────────────
// Same rule as everything above, and it matters more here: a rule is stored and then runs by itself
// later. A silently-defaulted trigger or condition would mean a rule that does something its author
// never asked for, on every future event, with nobody watching.

const AUTOMATION_TRIGGER: Record<string, string> = {
  conversation_created: 'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
  message_received: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
  status_changed: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
  first_reply_breached: 'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
};

/** Always required — there is no sensible default for "what does this rule react to". */
export function toTriggerWire(trigger?: string): string {
  if (!trigger) return reject('trigger', '', Object.keys(AUTOMATION_TRIGGER));
  return AUTOMATION_TRIGGER[trigger] ?? reject('trigger', trigger, Object.keys(AUTOMATION_TRIGGER));
}

const CONDITION_FIELD: Record<string, string> = {
  status: 'CONDITION_FIELD_STATUS',
  priority: 'CONDITION_FIELD_PRIORITY',
  brand: 'CONDITION_FIELD_BRAND',
  channel: 'CONDITION_FIELD_CHANNEL',
  assignee: 'CONDITION_FIELD_ASSIGNEE',
  label: 'CONDITION_FIELD_LABEL',
  message_text: 'CONDITION_FIELD_MESSAGE_TEXT',
};

const CONDITION_OP: Record<string, string> = {
  eq: 'CONDITION_OP_EQ',
  ne: 'CONDITION_OP_NE',
  present: 'CONDITION_OP_PRESENT',
  absent: 'CONDITION_OP_ABSENT',
  contains: 'CONDITION_OP_CONTAINS',
};

export function toConditionFieldWire(field?: string): string {
  if (!field) return reject('condition field', '', Object.keys(CONDITION_FIELD));
  return CONDITION_FIELD[field] ?? reject('condition field', field, Object.keys(CONDITION_FIELD));
}

export function toConditionOpWire(op?: string): string {
  if (!op) return reject('condition operator', '', Object.keys(CONDITION_OP));
  return CONDITION_OP[op] ?? reject('condition operator', op, Object.keys(CONDITION_OP));
}

export interface AutomationDefinitionInput {
  trigger?: string;
  conditions?: { field?: string; op?: string; value?: string }[];
  actions?: { type?: string; value?: string }[];
}

/**
 * A whole rule definition, validated at the edge before any RPC. Conditions MAY be empty (that is how
 * "every occurrence of the trigger" is expressed); actions may NOT (a rule that does nothing is a
 * configuration error, not a harmless no-op). Any invalid part rejects the WHOLE definition.
 */
export function toAutomationDefinitionWire(input?: AutomationDefinitionInput) {
  if (!input || typeof input !== 'object') {
    throw new BadRequestException('invalid definition: expected {trigger, conditions, actions}');
  }
  const trigger = toTriggerWire(input.trigger);
  const rawConditions = input.conditions ?? [];
  if (!Array.isArray(rawConditions)) {
    throw new BadRequestException('invalid conditions: expected an array of {field, op, value}');
  }
  const conditions = rawConditions.map((c) => ({
    field: toConditionFieldWire(c?.field),
    op: toConditionOpWire(c?.op),
    value: (c?.value ?? '').trim(),
  }));
  return { trigger, conditions, actions: toMacroActionsWire(input.actions) };
}

const SLA_OUTCOME: Record<string, string> = {
  running: 'SLA_OUTCOME_RUNNING',
  met: 'SLA_OUTCOME_MET',
  breached: 'SLA_OUTCOME_BREACHED',
};

/** Absent/empty → UNSPECIFIED (no filter). Unknown → 400, never a widened query. */
/**
 * Feature 029 — the Inbox's order. A CLOSED vocabulary, so fail-closed like status: an unknown value
 * is a 400, never the default.
 *
 * ⛔ There is no `recommended`. Roadmap 4.20 (the routing engine) is unbuilt and nothing computes
 * urgency, so a sort of that name would assert a property the data does not have — and unlike a
 * dropped filter, nobody can see it is wrong by looking at the list.
 */
const CONVERSATION_ORDER: Record<string, string> = {
  updated_desc: 'CONVERSATION_ORDER_UPDATED_DESC',
  updated_asc: 'CONVERSATION_ORDER_UPDATED_ASC',
};

export function toConversationOrderWire(order?: string): string {
  if (!order) return 'CONVERSATION_ORDER_UNSPECIFIED';
  return CONVERSATION_ORDER[order] ?? reject('order', order, Object.keys(CONVERSATION_ORDER));
}

/** The orders this edge accepts — the front end derives its sort control from exactly this set. */
export const CONVERSATION_ORDER_KEYS = Object.keys(CONVERSATION_ORDER);

/**
 * Feature 029 — the channel filter. ⚠️ **Shape-validated, NOT membership-validated**, and this is a
 * deliberate exception to the fail-closed rule above.
 *
 * ── Why `channel` cannot have a closed allow-list here ───────────────────────────────────────────
 * A channel is DATA, never a branch (roadmap 9.6a, binding: *"most channels are Phase 6 and unbuilt,
 * so a channel is audience/predicate data, never a branch"*). The column is a free-form string that
 * Phase 6 fills as connections are added. A hardcoded list at this edge would (a) be a branch on a
 * channel name, and (b) make every newly-ingested channel unfilterable until somebody edits the
 * gateway — a silent, confusing failure exactly when a new integration goes live.
 *
 * ── Why that is safe, where it would not be for `status` ─────────────────────────────────────────
 * The fail-closed rule exists to prevent SILENT WIDENING: a value that is dropped, so the caller
 * believes the list is narrowed and it is not. An unrecognised channel does not widen anything — it
 * narrows to zero rows, and an empty list is visibly different from a full one. `status` and `order`
 * are closed vocabularies known at build time, so an unknown value there is certainly a mistake;
 * `channel` is an open set, so an unknown value is indistinguishable from a channel we do not have
 * conversations on yet.
 *
 * What is still enforced: the value must be a non-empty, plausible token. A blank or absurd value is
 * a client error rather than a filter.
 */
const MAX_CHANNEL_LENGTH = 64;
const CHANNEL_SHAPE = /^[a-z0-9][a-z0-9_-]*$/i;

export function toChannelFilter(channel?: string): string {
  if (channel === undefined || channel === '') return '';
  if (channel.length > MAX_CHANNEL_LENGTH || !CHANNEL_SHAPE.test(channel)) {
    throw new BadRequestException('invalid channel: expected a short alphanumeric channel name');
  }
  return channel;
}

export function toSlaOutcomeWire(outcome?: string): string {
  if (!outcome) return 'SLA_OUTCOME_UNSPECIFIED';
  return SLA_OUTCOME[outcome] ?? reject('slaOutcome', outcome, Object.keys(SLA_OUTCOME));
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
