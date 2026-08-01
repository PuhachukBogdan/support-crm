import { matches } from './conditions';
import { parseConditions } from './rule-definition';
import type { ConversationFacts } from '../events/events.types';

/**
 * T016 (feature 014, US1) — the pure condition matcher. FAILS before the module exists, PASSES after.
 *
 * v1 semantics are a flat AND (spec Assumptions): every condition must hold. That is asserted
 * explicitly, because "one false condition still matched" is the kind of bug that silently applies a
 * rule to conversations it was never meant to touch.
 */
const T = 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED';
const cond = (field: string, op: string, value = '') => parseConditions([{ field, op, value }], T);

const facts: ConversationFacts = {
  status: 'open',
  priority: 'normal',
  brandId: 'b1',
  channel: 'web',
  hasAssignee: false,
  labelIds: ['l1', 'l2'],
  // Feature 024: unscoped work — no desk took it. Required, so the compiler names every fixture.
  routedGroupId: null,
  messageText: 'I need a REFUND for my deposit',
};

describe('matches — empty conditions', () => {
  it('matches everything (the "every occurrence of the trigger" case)', () => {
    expect(matches([], facts)).toBe(true);
  });
});

describe('matches — status / priority / brand / channel', () => {
  it('EQ compares the stored value against the wire name for status', () => {
    expect(matches(cond('CONDITION_FIELD_STATUS', 'CONDITION_OP_EQ', 'CONVERSATION_STATUS_OPEN'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_STATUS', 'CONDITION_OP_EQ', 'CONVERSATION_STATUS_PENDING'), facts)).toBe(false);
  });

  it('NE is the exact negation of EQ', () => {
    expect(matches(cond('CONDITION_FIELD_STATUS', 'CONDITION_OP_NE', 'CONVERSATION_STATUS_PENDING'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_STATUS', 'CONDITION_OP_NE', 'CONVERSATION_STATUS_OPEN'), facts)).toBe(false);
  });

  it('matches priority, brand and channel by exact value', () => {
    expect(matches(cond('CONDITION_FIELD_PRIORITY', 'CONDITION_OP_EQ', 'normal'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_PRIORITY', 'CONDITION_OP_EQ', 'high'), facts)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_BRAND', 'CONDITION_OP_EQ', 'b1'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_BRAND', 'CONDITION_OP_EQ', 'b2'), facts)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_CHANNEL', 'CONDITION_OP_EQ', 'web'), facts)).toBe(true);
  });

  // An unset priority/channel is null in storage. EQ must be false, NE must be TRUE — "priority is
  // not low" is legitimately satisfied by a conversation with no priority at all.
  it('treats a null priority/channel as absent, not as an empty string', () => {
    const bare = { ...facts, priority: null, channel: null };
    expect(matches(cond('CONDITION_FIELD_PRIORITY', 'CONDITION_OP_EQ', 'low'), bare)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_PRIORITY', 'CONDITION_OP_NE', 'low'), bare)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_CHANNEL', 'CONDITION_OP_EQ', 'web'), bare)).toBe(false);
  });
});

describe('matches — assignee presence', () => {
  it('ABSENT holds on an unassigned conversation, PRESENT on an assigned one', () => {
    expect(matches(cond('CONDITION_FIELD_ASSIGNEE', 'CONDITION_OP_ABSENT'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_ASSIGNEE', 'CONDITION_OP_PRESENT'), facts)).toBe(false);
    const assigned = { ...facts, hasAssignee: true };
    expect(matches(cond('CONDITION_FIELD_ASSIGNEE', 'CONDITION_OP_ABSENT'), assigned)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_ASSIGNEE', 'CONDITION_OP_PRESENT'), assigned)).toBe(true);
  });
});

describe('matches — label presence by id', () => {
  it('PRESENT / ABSENT test membership of the conversation label set', () => {
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_PRESENT', 'l1'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_PRESENT', 'l9'), facts)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_ABSENT', 'l9'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_ABSENT', 'l1'), facts)).toBe(false);
  });

  it('handles a conversation with no labels at all', () => {
    const bare = { ...facts, labelIds: [] };
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_PRESENT', 'l1'), bare)).toBe(false);
    expect(matches(cond('CONDITION_FIELD_LABEL', 'CONDITION_OP_ABSENT', 'l1'), bare)).toBe(true);
  });
});

describe('matches — message text CONTAINS', () => {
  it('is case-insensitive substring matching (operators type keywords in lower case)', () => {
    expect(matches(cond('CONDITION_FIELD_MESSAGE_TEXT', 'CONDITION_OP_CONTAINS', 'refund'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_MESSAGE_TEXT', 'CONDITION_OP_CONTAINS', 'REFUND'), facts)).toBe(true);
    expect(matches(cond('CONDITION_FIELD_MESSAGE_TEXT', 'CONDITION_OP_CONTAINS', 'chargeback'), facts)).toBe(false);
  });

  // The event carries no text for non-message triggers; such a condition can only be FALSE, never a
  // crash and never an accidental match.
  it('is false — not a crash — when the event carries no message text', () => {
    const noText = { ...facts, messageText: undefined };
    expect(matches(cond('CONDITION_FIELD_MESSAGE_TEXT', 'CONDITION_OP_CONTAINS', 'refund'), noText)).toBe(false);
  });
});

describe('matches — flat AND semantics (v1)', () => {
  const all = parseConditions(
    [
      { field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' },
      { field: 'CONDITION_FIELD_MESSAGE_TEXT', op: 'CONDITION_OP_CONTAINS', value: 'refund' },
      { field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_EQ', value: 'CONVERSATION_STATUS_OPEN' },
    ],
    T,
  );

  it('matches only when every condition holds', () => {
    expect(matches(all, facts)).toBe(true);
  });

  it.each([
    ['assignee', { ...facts, hasAssignee: true }],
    ['keyword', { ...facts, messageText: 'hello there' }],
    ['status', { ...facts, status: 'resolved' }],
  ])('fails the whole set when the %s condition fails', (_which, f) => {
    expect(matches(all, f as ConversationFacts)).toBe(false);
  });
});
