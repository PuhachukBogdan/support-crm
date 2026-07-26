import { isValidPriority, isValidStatusWire } from '../shared/wire';
import { isAutomationTrigger, type AutomationTrigger } from '../events/events.types';
import {
  ACTION_PERMISSION,
  MACRO_ACTION_TYPES,
  type MacroAction,
  type MacroActionType,
} from '../macros/macro-definition';

/**
 * Automation-rule definition shape + validation (feature 014, US1 — roadmap 4.6).
 *
 * A rule is stored as Json on `Automation.definition`:
 *   { "trigger": "AUTOMATION_TRIGGER_…",
 *     "conditions": [ { "field": "CONDITION_FIELD_…", "op": "CONDITION_OP_…", "value": "…" } ],
 *     "actions":    [ { "type": "MACRO_ACTION_TYPE_…", "value": "…" } ] }
 *
 * The action vocabulary is the SAME one macros use (`macros/macro-definition.ts`) — deliberately, so
 * "what a one-click bundle may do" and "what a rule may do" can never drift apart, and so each action
 * keeps carrying its own required permission.
 *
 * Governing rule, as in 013: **unknown ⇒ refuse, never default** — enforced at authoring AND at run
 * time, because a definition outlives the code that wrote it. A rule stored by a looser version must
 * not silently resolve to something this version invented.
 *
 * Pure module: no Prisma, no I/O, no clock. Unit-tested directly.
 */

/** Thrown for a malformed definition; callers map it to INVALID_ARGUMENT / FAILED_PRECONDITION. */
export class RuleDefinitionError extends Error {}

export const CONDITION_FIELDS = [
  'CONDITION_FIELD_STATUS',
  'CONDITION_FIELD_PRIORITY',
  'CONDITION_FIELD_BRAND',
  'CONDITION_FIELD_CHANNEL',
  'CONDITION_FIELD_ASSIGNEE',
  'CONDITION_FIELD_LABEL',
  'CONDITION_FIELD_MESSAGE_TEXT',
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPS = [
  'CONDITION_OP_EQ',
  'CONDITION_OP_NE',
  'CONDITION_OP_PRESENT',
  'CONDITION_OP_ABSENT',
  'CONDITION_OP_CONTAINS',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface RuleCondition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export interface RuleDefinition {
  trigger: AutomationTrigger;
  conditions: RuleCondition[];
  actions: MacroAction[];
}

/** Which ops each field supports. A pairing outside this table is a definition error. */
const FIELD_OPS: Readonly<Record<ConditionField, readonly ConditionOp[]>> = {
  CONDITION_FIELD_STATUS: ['CONDITION_OP_EQ', 'CONDITION_OP_NE'],
  CONDITION_FIELD_PRIORITY: ['CONDITION_OP_EQ', 'CONDITION_OP_NE'],
  CONDITION_FIELD_BRAND: ['CONDITION_OP_EQ', 'CONDITION_OP_NE'],
  CONDITION_FIELD_CHANNEL: ['CONDITION_OP_EQ', 'CONDITION_OP_NE'],
  CONDITION_FIELD_ASSIGNEE: ['CONDITION_OP_PRESENT', 'CONDITION_OP_ABSENT'],
  CONDITION_FIELD_LABEL: ['CONDITION_OP_PRESENT', 'CONDITION_OP_ABSENT'],
  CONDITION_FIELD_MESSAGE_TEXT: ['CONDITION_OP_CONTAINS'],
};

/** Fields that need a comparison value. ASSIGNEE presence needs none. */
const NEEDS_VALUE: ReadonlySet<ConditionField> = new Set<ConditionField>([
  'CONDITION_FIELD_STATUS',
  'CONDITION_FIELD_PRIORITY',
  'CONDITION_FIELD_BRAND',
  'CONDITION_FIELD_CHANNEL',
  'CONDITION_FIELD_LABEL',
  'CONDITION_FIELD_MESSAGE_TEXT',
]);

/** The "any scope" sentinel of the SLA policy (research R7) — never a real stored value. */
const ANY_SENTINEL = '*';

const isField = (v: unknown): v is ConditionField =>
  typeof v === 'string' && (CONDITION_FIELDS as readonly string[]).includes(v);
const isOp = (v: unknown): v is ConditionOp =>
  typeof v === 'string' && (CONDITION_OPS as readonly string[]).includes(v);
const isActionType = (v: unknown): v is MacroActionType =>
  typeof v === 'string' && (MACRO_ACTION_TYPES as readonly string[]).includes(v);

/** Validate a trigger name. UNSPECIFIED is refused: a rule must say what it reacts to. */
export function parseTrigger(input: unknown): AutomationTrigger {
  if (!isAutomationTrigger(input)) throw new RuleDefinitionError('unknown automation trigger');
  return input;
}

/**
 * Validate an action list for a rule. Same vocabulary and same per-action value rules as a macro,
 * with one extra: the SLA sentinel `'*'` may never be a literal action value.
 */
export function parseRuleActions(input: unknown): MacroAction[] {
  if (!Array.isArray(input) || input.length === 0) {
    // A rule with no actions is a configuration error, not a harmless no-op: it would evaluate,
    // match, record a run and change nothing — indistinguishable from a broken rule.
    throw new RuleDefinitionError('a rule needs at least one action');
  }
  return input.map((raw) => {
    const a = (raw ?? {}) as { type?: unknown; value?: unknown };
    if (!isActionType(a.type)) throw new RuleDefinitionError('unknown action type');
    const value = typeof a.value === 'string' ? a.value.trim() : '';
    if (!value) throw new RuleDefinitionError('action value must not be empty');
    if (value === ANY_SENTINEL) throw new RuleDefinitionError("'*' is not a valid action value");
    if (a.type === 'MACRO_ACTION_TYPE_SET_STATUS' && !isValidStatusWire(value)) {
      throw new RuleDefinitionError('SET_STATUS value is not a valid status');
    }
    if (a.type === 'MACRO_ACTION_TYPE_SET_PRIORITY' && !isValidPriority(value)) {
      throw new RuleDefinitionError('SET_PRIORITY value is not a valid priority');
    }
    return { type: a.type, value };
  });
}

/**
 * Validate a condition list **against its trigger**. An empty list is legal (= every occurrence).
 *
 * The trigger matters because `message_contains` can only be evaluated on an event that carries a
 * message. Refusing it elsewhere at authoring time is the point: a rule that can never match is far
 * harder to debug than a rule that refused to be saved.
 */
export function parseConditions(input: unknown, trigger: AutomationTrigger): RuleCondition[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new RuleDefinitionError('conditions must be a list');
  return input.map((raw) => {
    const c = (raw ?? {}) as { field?: unknown; op?: unknown; value?: unknown };
    if (!isField(c.field)) throw new RuleDefinitionError('unknown condition field');
    if (!isOp(c.op)) throw new RuleDefinitionError('unknown condition operator');
    if (!FIELD_OPS[c.field].includes(c.op)) {
      throw new RuleDefinitionError('condition operator is not valid for that field');
    }
    if (
      c.field === 'CONDITION_FIELD_MESSAGE_TEXT' &&
      trigger !== 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED'
    ) {
      throw new RuleDefinitionError('message text can only be matched on a message trigger');
    }
    const value = typeof c.value === 'string' ? c.value.trim() : '';
    if (NEEDS_VALUE.has(c.field) && !value) {
      throw new RuleDefinitionError('condition value must not be empty');
    }
    if (c.field === 'CONDITION_FIELD_STATUS' && !isValidStatusWire(value)) {
      throw new RuleDefinitionError('condition status is not a valid status');
    }
    if (c.field === 'CONDITION_FIELD_PRIORITY' && !isValidPriority(value)) {
      throw new RuleDefinitionError('condition priority is not a valid priority');
    }
    return { field: c.field, op: c.op, value };
  });
}

/** Parse a whole definition (an inbound request body or a stored blob). All-or-nothing. */
export function parseDefinition(input: unknown): RuleDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RuleDefinitionError('definition must be an object');
  }
  const d = input as { trigger?: unknown; conditions?: unknown; actions?: unknown };
  const trigger = parseTrigger(d.trigger);
  return {
    trigger,
    conditions: parseConditions(d.conditions, trigger),
    actions: parseRuleActions(d.actions),
  };
}

/** The storage shape for a validated definition. */
export function toStoredDefinition(def: RuleDefinition): RuleDefinition {
  return { trigger: def.trigger, conditions: def.conditions, actions: def.actions };
}

/**
 * Every distinct permission this rule's actions require (deduplicated, order-stable).
 *
 * This is the list checked against the AUTHOR's live permissions before any write (FR-023). Authoring
 * a rule is therefore never a way to perform an action the author could not perform directly.
 */
export function requiredRulePermissions(def: RuleDefinition): string[] {
  const keys: string[] = [];
  for (const a of def.actions) {
    const key = ACTION_PERMISSION[a.type];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
