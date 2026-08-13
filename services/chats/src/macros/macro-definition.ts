import { isValidPriority } from '../shared/wire';

/**
 * Macro definition shape + validation (feature 013, US2 — research R4).
 *
 * A macro is an ordered list of actions stored as Json on `Macro.definition`:
 *   { "actions": [ { "type": "MACRO_ACTION_TYPE_…", "value": "…" } ] }
 *
 * The v1 action set is deliberately small and closed — set status, add label, assign. Richer
 * actions (send a message, apply SLA, trigger an automation) belong to roadmap 4.6/4.7. An unknown
 * type is rejected at **define** time AND re-validated at **apply** time, because a definition can
 * outlive the code that wrote it: a macro stored by an older/looser version must not silently
 * perform something this version does not understand.
 *
 * Pure module — no Prisma, no I/O, no clock. Unit-tested directly.
 *
 * ── ⭐ Feature 032: `statusKeys` is a REQUIRED parameter, not an option ───────────────────────────
 * A `SET_STATUS` value used to be checked against a four-value enum in code. Statuses are now the
 * ACCOUNT's configuration, so the check needs data the caller has and this module must not fetch.
 *
 * It is required rather than optional for the reason feature 023 made `actor` required on `setStatus`:
 * an optional parameter lets every existing call site keep compiling while silently validating nothing,
 * which is the exact hole the check exists to close. Call sites that fail to compile are the feature
 * working. Pass the account's **active** keys — a retired status must not be selectable by a new
 * definition, which is what retiring one means.
 */

export const MACRO_ACTION_TYPES = [
  'MACRO_ACTION_TYPE_SET_STATUS',
  'MACRO_ACTION_TYPE_ADD_LABEL',
  'MACRO_ACTION_TYPE_ASSIGN',
  // Feature 014 (roadmap 4.6/4.7): the vocabulary is now SHARED by macros and automation rules.
  // Appended, never reordered — a stored definition must keep its meaning.
  'MACRO_ACTION_TYPE_SET_PRIORITY',
] as const;

export type MacroActionType = (typeof MACRO_ACTION_TYPES)[number];

export interface MacroAction {
  type: MacroActionType;
  value: string;
}

/** Thrown for a malformed definition — the caller maps it to INVALID_ARGUMENT. */
export class MacroDefinitionError extends Error {}

/**
 * The permission each action requires **in addition to** the macro-apply permission. Bundling
 * actions must never be a way around a permission the caller does not hold (Principle II), so
 * `ASSIGN` inside a macro needs exactly the same key as assigning directly.
 */
export const ACTION_PERMISSION: Readonly<Record<MacroActionType, string | null>> = {
  MACRO_ACTION_TYPE_SET_STATUS: 'crm.conversation.reply',
  MACRO_ACTION_TYPE_ADD_LABEL: 'crm.labels.manage',
  MACRO_ACTION_TYPE_ASSIGN: 'crm.conversation.assign',
  // Feature 014: changing priority is the same class of act as changing status, so it reuses the
  // same key rather than fragmenting the catalogue with `crm.conversation.priority` (research R9).
  MACRO_ACTION_TYPE_SET_PRIORITY: 'crm.conversation.reply',
};

const isActionType = (t: unknown): t is MacroActionType =>
  typeof t === 'string' && (MACRO_ACTION_TYPES as readonly string[]).includes(t);

/**
 * Validate + normalise a list of actions (used by DefineMacro on the inbound request).
 * Throws {@link MacroDefinitionError} on anything unrecognised — never drops or coerces an action.
 */
export function parseActions(input: unknown, statusKeys: readonly string[]): MacroAction[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new MacroDefinitionError('a macro needs at least one action');
  }
  return input.map((raw) => {
    const a = (raw ?? {}) as { type?: unknown; value?: unknown };
    if (!isActionType(a.type)) {
      throw new MacroDefinitionError('unknown macro action type');
    }
    const value = typeof a.value === 'string' ? a.value.trim() : '';
    if (!value) throw new MacroDefinitionError('macro action value must not be empty');
    // Feature 032: the value is a status KEY and must be one this account has configured and not
    // retired. The message names no key back to the caller — the catalogue is theirs to read.
    if (a.type === 'MACRO_ACTION_TYPE_SET_STATUS' && !statusKeys.includes(value)) {
      throw new MacroDefinitionError('macro SET_STATUS value is not a valid status');
    }
    // Feature 014: a stored SET_PRIORITY must name a priority the product understands. Refusing
    // here is what keeps a rule from parking an unrecognised priority on a conversation.
    if (a.type === 'MACRO_ACTION_TYPE_SET_PRIORITY' && !isValidPriority(value)) {
      throw new MacroDefinitionError('SET_PRIORITY value is not a valid priority');
    }
    return { type: a.type, value };
  });
}

/** Parse a stored `definition` Json blob back into validated actions (used by ApplyMacro). */
export function parseDefinition(
  definition: unknown,
  statusKeys: readonly string[],
): MacroAction[] {
  const d = (definition ?? {}) as { actions?: unknown };
  return parseActions(d.actions, statusKeys);
}

/** The storage shape for a validated action list. */
export function toDefinition(actions: MacroAction[]): { actions: MacroAction[] } {
  return { actions };
}

/** Every distinct permission an action list requires (deduplicated, order-stable). */
export function requiredPermissions(actions: MacroAction[]): string[] {
  const keys: string[] = [];
  for (const a of actions) {
    const key = ACTION_PERMISSION[a.type];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}
