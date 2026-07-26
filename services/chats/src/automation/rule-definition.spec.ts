import {
  RuleDefinitionError,
  parseDefinition,
  parseRuleActions,
  parseConditions,
  parseTrigger,
  requiredRulePermissions,
  toStoredDefinition,
} from './rule-definition';

/**
 * T015 (feature 014, US1) — the pure rule validator. FAILS before the module exists, PASSES after.
 *
 * The governing rule, inherited from 013's macro validator and made stricter here: **unknown ⇒
 * refuse, never default**. It applies at authoring AND at run time, because a definition outlives the
 * code that wrote it — a rule stored by a looser version must not silently resolve to something this
 * version invented (spec Edge Cases).
 */
const ACT_LABEL = { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' };

describe('parseTrigger', () => {
  it('accepts the four v1 triggers', () => {
    for (const t of [
      'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
      'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      'AUTOMATION_TRIGGER_STATUS_CHANGED',
      'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
    ]) {
      expect(parseTrigger(t)).toBe(t);
    }
  });

  it.each([
    'AUTOMATION_TRIGGER_UNSPECIFIED', // a rule must NAME its trigger
    'MESSAGE_RECEIVED',
    'AUTOMATION_TRIGGER_MESSAGE_SENT',
    'conversation.created',
    '',
    undefined,
    null,
    7,
  ])('refuses the trigger %p', (t) => {
    expect(() => parseTrigger(t)).toThrow(RuleDefinitionError);
  });
});

describe('parseRuleActions', () => {
  it('accepts the shared action vocabulary incl. the new SET_PRIORITY', () => {
    expect(
      parseRuleActions([ACT_LABEL, { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }]),
    ).toEqual([ACT_LABEL, { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }]);
  });

  it('refuses an EMPTY action list — a rule that does nothing is a configuration error', () => {
    expect(() => parseRuleActions([])).toThrow(RuleDefinitionError);
    expect(() => parseRuleActions(undefined)).toThrow(RuleDefinitionError);
  });

  it.each(['MACRO_ACTION_TYPE_SEND_MESSAGE', 'NOTIFY', 'ESCALATE', 'add_label', ''])(
    'refuses the unknown action type %p (notify/escalate are deliberately NOT v1)',
    (type) => {
      expect(() => parseRuleActions([{ type, value: 'x' }])).toThrow(RuleDefinitionError);
    },
  );

  it('refuses a bogus status or priority value inside an action', () => {
    expect(() =>
      parseRuleActions([{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_CLOSED' }]),
    ).toThrow(RuleDefinitionError);
    expect(() =>
      parseRuleActions([{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'urgent' }]),
    ).toThrow(RuleDefinitionError);
  });

  // '*' is the SLA "any scope" sentinel (research R7) — it must never be storable as a real value.
  it("refuses '*' as a literal action value", () => {
    expect(() =>
      parseRuleActions([{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: '*' }]),
    ).toThrow(RuleDefinitionError);
    expect(() => parseRuleActions([{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: '*' }])).toThrow(
      RuleDefinitionError,
    );
  });
});

describe('parseConditions', () => {
  const T_MSG = 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED';
  const T_STATUS = 'AUTOMATION_TRIGGER_STATUS_CHANGED';

  it('accepts an EMPTY condition list (that is how "every occurrence" is expressed)', () => {
    expect(parseConditions([], T_MSG)).toEqual([]);
    expect(parseConditions(undefined, T_MSG)).toEqual([]);
  });

  it('accepts each documented field/op pairing', () => {
    const ok = [
      { field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_EQ', value: 'CONVERSATION_STATUS_OPEN' },
      { field: 'CONDITION_FIELD_PRIORITY', op: 'CONDITION_OP_NE', value: 'low' },
      { field: 'CONDITION_FIELD_BRAND', op: 'CONDITION_OP_EQ', value: 'b1' },
      { field: 'CONDITION_FIELD_CHANNEL', op: 'CONDITION_OP_EQ', value: 'web' },
      { field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' },
      { field: 'CONDITION_FIELD_LABEL', op: 'CONDITION_OP_PRESENT', value: 'l1' },
      { field: 'CONDITION_FIELD_MESSAGE_TEXT', op: 'CONDITION_OP_CONTAINS', value: 'refund' },
    ];
    expect(parseConditions(ok, T_MSG)).toHaveLength(ok.length);
  });

  it.each(['CONDITION_FIELD_UNSPECIFIED', 'CONDITION_FIELD_TAGS', 'status', ''])(
    'refuses the unknown field %p',
    (field) => {
      expect(() => parseConditions([{ field, op: 'CONDITION_OP_EQ', value: 'x' }], T_MSG)).toThrow(
        RuleDefinitionError,
      );
    },
  );

  it.each(['CONDITION_OP_UNSPECIFIED', 'CONDITION_OP_GT', 'eq', ''])(
    'refuses the unknown op %p',
    (op) => {
      expect(() =>
        parseConditions([{ field: 'CONDITION_FIELD_STATUS', op, value: 'x' }], T_MSG),
      ).toThrow(RuleDefinitionError);
    },
  );

  // A condition that can never be evaluated is a definition error, not a rule that quietly never
  // matches — the second is far harder to debug than the first.
  it('refuses message_contains under a non-message trigger', () => {
    const cond = [
      { field: 'CONDITION_FIELD_MESSAGE_TEXT', op: 'CONDITION_OP_CONTAINS', value: 'refund' },
    ];
    expect(parseConditions(cond, T_MSG)).toHaveLength(1);
    expect(() => parseConditions(cond, T_STATUS)).toThrow(RuleDefinitionError);
    expect(() =>
      parseConditions(cond, 'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED'),
    ).toThrow(RuleDefinitionError);
  });

  it('refuses an op the field does not support', () => {
    // CONTAINS is text-only…
    expect(() =>
      parseConditions(
        [{ field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_CONTAINS', value: 'open' }],
        T_MSG,
      ),
    ).toThrow(RuleDefinitionError);
    // …and PRESENT/ABSENT only make sense for assignee/label.
    expect(() =>
      parseConditions(
        [{ field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_PRESENT', value: '' }],
        T_MSG,
      ),
    ).toThrow(RuleDefinitionError);
  });

  it('requires a value where the op compares one, and rejects a blank keyword', () => {
    expect(() =>
      parseConditions([{ field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_EQ', value: '' }], T_MSG),
    ).toThrow(RuleDefinitionError);
    expect(() =>
      parseConditions(
        [{ field: 'CONDITION_FIELD_MESSAGE_TEXT', op: 'CONDITION_OP_CONTAINS', value: '   ' }],
        T_MSG,
      ),
    ).toThrow(RuleDefinitionError);
  });

  it('requires a label id for LABEL PRESENT/ABSENT but not for ASSIGNEE', () => {
    expect(() =>
      parseConditions([{ field: 'CONDITION_FIELD_LABEL', op: 'CONDITION_OP_PRESENT', value: '' }], T_MSG),
    ).toThrow(RuleDefinitionError);
    expect(
      parseConditions([{ field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_PRESENT', value: '' }], T_MSG),
    ).toHaveLength(1);
  });

  it('refuses a status/priority value that is not in its allow-list', () => {
    expect(() =>
      parseConditions(
        [{ field: 'CONDITION_FIELD_STATUS', op: 'CONDITION_OP_EQ', value: 'CONVERSATION_STATUS_CLOSED' }],
        T_MSG,
      ),
    ).toThrow(RuleDefinitionError);
    expect(() =>
      parseConditions(
        [{ field: 'CONDITION_FIELD_PRIORITY', op: 'CONDITION_OP_EQ', value: 'urgent' }],
        T_MSG,
      ),
    ).toThrow(RuleDefinitionError);
  });
});

describe('parseDefinition / round-trip', () => {
  const valid = {
    trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
    conditions: [
      { field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' },
      { field: 'CONDITION_FIELD_MESSAGE_TEXT', op: 'CONDITION_OP_CONTAINS', value: 'refund' },
    ],
    actions: [ACT_LABEL, { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' }],
  };

  it('round-trips a valid definition through storage unchanged', () => {
    const parsed = parseDefinition(valid);
    expect(parseDefinition(toStoredDefinition(parsed))).toEqual(parsed);
  });

  it('refuses a definition whose trigger is fine but whose actions are empty', () => {
    expect(() => parseDefinition({ ...valid, actions: [] })).toThrow(RuleDefinitionError);
  });

  it('refuses a stored blob that is not an object', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(() => parseDefinition(bad)).toThrow(RuleDefinitionError);
    }
  });

  it('refuses the WHOLE definition when any single part is invalid (no partial parse)', () => {
    expect(() =>
      parseDefinition({ ...valid, actions: [ACT_LABEL, { type: 'NOPE', value: 'x' }] }),
    ).toThrow(RuleDefinitionError);
  });
});

describe('requiredRulePermissions', () => {
  it('is the union of what each action needs on its own (no bundling loophole)', () => {
    const def = parseDefinition({
      trigger: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
      conditions: [],
      actions: [
        ACT_LABEL,
        { type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-1' },
        { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
      ],
    });
    expect(requiredRulePermissions(def).sort()).toEqual(
      ['crm.conversation.assign', 'crm.conversation.reply', 'crm.labels.manage'].sort(),
    );
  });
});
