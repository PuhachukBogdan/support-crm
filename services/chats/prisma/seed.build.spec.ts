import { buildSeed } from './seed.build';
import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  SEED_PLAYER_ID,
  SEED_CONVERSATION_UNASSIGNED_ID,
  SEED_MACRO_ID,
  SEED_MACRO_ASSIGN_ID,
  SEED_AUTOMATION_KEYWORD_ID,
  SEED_AUTOMATION_ASSIGN_ID,
  SEED_AUTOMATION_SELF_ID,
  SEED_AUTOMATION_BREACH_ID,
  SEED_AUTOMATION_KEYWORD,
  SEED_CONVERSATION_SLA_ID,
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

/**
 * T030 (feature 014) — the automation + SLA fixtures. FAILS before the seed delta, PASSES after.
 *
 * These fixtures exist so Track B can prove behaviour that no mocked test can: a rule firing with no
 * operator present, and a breach detected by a timer. So the assertions here are about the fixtures
 * being *usable for that purpose* — every definition must be valid, each rule must have the exact
 * shape its scenario needs, and the ones that mutate shared state must ship DISABLED so a leftover
 * enabled rule from a previous run cannot masquerade as a product defect.
 */
describe('chats seed — feature 014 (automations + first-reply SLA)', () => {
  const seed = buildSeed();
  const rule = (id: string) => seed.automations.find((a) => a.id === id)!;
  const defOf = (id: string) =>
    rule(id).definition as {
      trigger: string;
      conditions: { field: string; op: string; value: string }[];
      actions: { type: string; value: string }[];
    };

  it('ships the four scenario rules', () => {
    expect(seed.automations.map((a) => a.id).sort()).toEqual(
      [
        SEED_AUTOMATION_KEYWORD_ID,
        SEED_AUTOMATION_ASSIGN_ID,
        SEED_AUTOMATION_SELF_ID,
        SEED_AUTOMATION_BREACH_ID,
      ].sort(),
    );
  });

  it('every rule names an author — a rule with no authority could only ever be refused (FR-024)', () => {
    for (const r of seed.automations) expect(r.author_user_id.length).toBeGreaterThan(0);
  });

  it('every definition is well formed: a known trigger, a non-empty action list, prefixed wire values', () => {
    for (const r of seed.automations) {
      const d = r.definition as { trigger: string; actions: { type: string; value: string }[] };
      expect(d.trigger.startsWith('AUTOMATION_TRIGGER_')).toBe(true);
      expect(d.trigger).not.toBe('AUTOMATION_TRIGGER_UNSPECIFIED');
      expect(d.actions.length).toBeGreaterThan(0);
      for (const a of d.actions) {
        expect(a.type.startsWith('MACRO_ACTION_TYPE_')).toBe(true);
        expect(a.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('the keyword rule matches message text AND requires an unassigned conversation', () => {
    const d = defOf(SEED_AUTOMATION_KEYWORD_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_MESSAGE_RECEIVED');
    expect(d.conditions.map((c) => c.field).sort()).toEqual(
      ['CONDITION_FIELD_ASSIGNEE', 'CONDITION_FIELD_MESSAGE_TEXT'].sort(),
    );
    expect(d.conditions.find((c) => c.field === 'CONDITION_FIELD_MESSAGE_TEXT')!.value).toBe(
      SEED_AUTOMATION_KEYWORD,
    );
    expect(rule(SEED_AUTOMATION_KEYWORD_ID).active).toBe(true);
  });

  it('the ASSIGN rule is the permission-refusal fixture and ships DISABLED', () => {
    expect(defOf(SEED_AUTOMATION_ASSIGN_ID).actions.map((a) => a.type)).toContain(
      'MACRO_ACTION_TYPE_ASSIGN',
    );
    expect(rule(SEED_AUTOMATION_ASSIGN_ID).active).toBe(false);
  });

  it('the self-satisfying rule really is self-satisfying (and ships DISABLED)', () => {
    const d = defOf(SEED_AUTOMATION_SELF_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_STATUS_CHANGED');
    // Its own action re-satisfies its own trigger — the worst case for SC-004, on purpose.
    expect(d.actions.map((a) => a.type)).toEqual(['MACRO_ACTION_TYPE_SET_STATUS']);
    expect(rule(SEED_AUTOMATION_SELF_ID).active).toBe(false);
  });

  it('the breach rule reacts to a missed target with a label + a priority raise', () => {
    const d = defOf(SEED_AUTOMATION_BREACH_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED');
    expect(d.actions.map((a) => a.type).sort()).toEqual(
      ['MACRO_ACTION_TYPE_ADD_LABEL', 'MACRO_ACTION_TYPE_SET_PRIORITY'].sort(),
    );
    expect(rule(SEED_AUTOMATION_BREACH_ID).active).toBe(true);
  });

  it('rules reference labels that the seed actually creates (else they would refuse at run time)', () => {
    const labelIds = new Set(seed.labels.map((l) => l.id));
    for (const r of seed.automations) {
      const d = r.definition as { actions: { type: string; value: string }[] };
      for (const a of d.actions) {
        if (a.type === 'MACRO_ACTION_TYPE_ADD_LABEL') expect(labelIds.has(a.value)).toBe(true);
      }
    }
  });

  it('ships ONE account-level SLA target using the "*" sentinels, not NULLs (research R7)', () => {
    expect(seed.slaPolicies).toHaveLength(1);
    const p = seed.slaPolicies[0]!;
    expect(p.scope_priority).toBe('*');
    expect(p.scope_brand_id).toBe('*');
    expect(p.target_minutes).toBeGreaterThan(0);
  });

  it('ships an SLA conversation with NO messages, so its clock starts from a known state', () => {
    const conv = seed.conversations.find((c) => c.id === SEED_CONVERSATION_SLA_ID);
    expect(conv).toBeDefined();
    expect(conv!.assignee_operator_id).toBeNull();
    expect(seed.messages.some((m) => m.conversation_id === SEED_CONVERSATION_SLA_ID)).toBe(false);
  });
});
