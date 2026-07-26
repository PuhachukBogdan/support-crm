import { buildSeed } from './seed.build';
import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  SEED_PLAYER_ID,
  SEED_CONVERSATION_UNASSIGNED_ID,
  SEED_MACRO_ID,
  SEED_MACRO_ASSIGN_ID,
} from '@crm/common';

/**
 * US1 (feature 008): the chats seed builder yields a label + two conversations (reserved classification
 * exercised) + messages (incl. a private note) + a conversation-label link. Pure — no DB (Track A).
 */
describe('chats seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [
      ...seed.labels,
      ...seed.conversations,
      ...seed.messages,
      ...seed.macros,
      ...seed.cannedResponses,
    ]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('conversations share the player and span two brands (player brand-union, feature 012 US3)', () => {
    for (const c of seed.conversations) {
      expect(c.player_id).toBe(SEED_PLAYER_ID);
    }
    const brands = new Set(seed.conversations.map((c) => c.brand_id));
    expect(brands.has(SEED_BRAND_ID)).toBe(true);
    expect(brands.has(SEED_BRAND_ID_2)).toBe(true); // same player_id spanning brands
    // at least one conversation is classified (reserved fields, ADR 0027)
    expect(seed.conversations.some((c) => c.category === 'billing' && c.classified_by === 'seed')).toBe(true);
  });

  it('includes at least one private (internal) message', () => {
    expect(seed.messages.some((m) => m.private === true)).toBe(true);
  });

  it('links the open conversation to the label', () => {
    expect(seed.conversationLabels.length).toBeGreaterThan(0);
  });

  // ── feature 013 (workflow) fixtures ──
  it('ships an UNASSIGNED conversation so assign/reassign/unassign has a clean start (US1)', () => {
    const unassigned = seed.conversations.find((c) => c.id === SEED_CONVERSATION_UNASSIGNED_ID);
    expect(unassigned).toBeDefined();
    expect(unassigned!.assignee_operator_id).toBeNull();
    // and at least one conversation IS assigned, so reassignment has a fixture too
    expect(seed.conversations.some((c) => c.assignee_operator_id !== null)).toBe(true);
  });

  it('ships a second label so attach has a target that is not already linked (US2)', () => {
    expect(seed.labels.length).toBeGreaterThanOrEqual(2);
    const linked = new Set(seed.conversationLabels.map((l) => l.label_id));
    expect(seed.labels.some((l) => !linked.has(l.id))).toBe(true);
  });

  it('ships two macros: one self-contained, one containing ASSIGN (the all-or-nothing fixture)', () => {
    const actionsOf = (id: string) =>
      (seed.macros.find((m) => m.id === id)!.definition as { actions: { type: string }[] }).actions;

    const plain = actionsOf(SEED_MACRO_ID).map((a) => a.type);
    expect(plain).toEqual([
      'MACRO_ACTION_TYPE_SET_STATUS',
      'MACRO_ACTION_TYPE_ADD_LABEL',
    ]);

    const withAssign = actionsOf(SEED_MACRO_ASSIGN_ID).map((a) => a.type);
    expect(withAssign).toContain('MACRO_ACTION_TYPE_ASSIGN');
  });

  it('every macro action carries a non-empty value and a prefixed wire type (R4)', () => {
    for (const macro of seed.macros) {
      const { actions } = macro.definition as { actions: { type: string; value: string }[] };
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) {
        expect(a.type.startsWith('MACRO_ACTION_TYPE_')).toBe(true);
        expect(a.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('ships a canned response with text only — no conversation or message link (FR-009)', () => {
    expect(seed.cannedResponses.length).toBeGreaterThan(0);
    for (const c of seed.cannedResponses) {
      expect(c.body.length).toBeGreaterThan(0);
      expect(Object.keys(c)).toEqual(
        expect.not.arrayContaining(['conversation_id', 'message_id', 'player_id']),
      );
    }
  });
});
