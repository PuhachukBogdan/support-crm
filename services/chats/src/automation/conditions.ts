import type { ConversationFacts } from '../events/events.types';
import { statusToWire } from '../shared/wire';
import type { RuleCondition } from './rule-definition';

/**
 * Condition matching (feature 014, US1 — roadmap 4.6). Pure: no Prisma, no I/O, no clock.
 *
 * v1 is a flat **AND** — every condition must hold (spec Assumptions). No OR, no nesting, no
 * negation beyond the explicit ABSENT / NE forms. Richer expressions wait for a demonstrated need;
 * a condition language is easy to add and very hard to take away.
 *
 * `messageText` is matched **in memory only**. It is never written to a run record, a log or an error
 * payload (FR-020 / SEC-26) — a keyword rule records *that* it matched, never what it matched on.
 */
export function matches(conditions: RuleCondition[], facts: ConversationFacts): boolean {
  return conditions.every((c) => matchOne(c, facts));
}

function matchOne(c: RuleCondition, f: ConversationFacts): boolean {
  switch (c.field) {
    case 'CONDITION_FIELD_STATUS':
      // Definitions store the WIRE status name, storage keeps the scalar — compare in wire space.
      return compare(c.op, statusToWire(f.status), c.value);
    case 'CONDITION_FIELD_PRIORITY':
      return compare(c.op, f.priority, c.value);
    case 'CONDITION_FIELD_BRAND':
      return compare(c.op, f.brandId, c.value);
    case 'CONDITION_FIELD_CHANNEL':
      return compare(c.op, f.channel, c.value);
    case 'CONDITION_FIELD_ASSIGNEE':
      return c.op === 'CONDITION_OP_PRESENT' ? f.hasAssignee : !f.hasAssignee;
    case 'CONDITION_FIELD_LABEL': {
      const present = (f.labelIds ?? []).includes(c.value);
      return c.op === 'CONDITION_OP_PRESENT' ? present : !present;
    }
    case 'CONDITION_FIELD_MESSAGE_TEXT': {
      // No text on this event ⇒ the condition is FALSE. Never a crash, and never an accidental
      // match: a keyword rule must not fire on an event that carries nothing to match.
      const text = f.messageText;
      if (typeof text !== 'string') return false;
      return text.toLowerCase().includes(c.value.toLowerCase());
    }
  }
}

/**
 * EQ / NE against a possibly-absent value. An unset priority or channel is `null` in storage, so
 * `EQ` is false and `NE` is **true** — "priority is not low" is legitimately satisfied by a
 * conversation that has no priority at all. Treating null as `''` would make both false and quietly
 * exclude exactly the unclassified conversations these rules usually target.
 */
function compare(op: RuleCondition['op'], actual: string | null | undefined, expected: string): boolean {
  const equal = actual !== null && actual !== undefined && actual === expected;
  return op === 'CONDITION_OP_EQ' ? equal : !equal;
}
