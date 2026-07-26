import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  SEED_PLAYER_ID,
  SEED_OPERATOR_ID,
  SEED_LABEL_ID,
  SEED_CONVERSATION_OPEN_ID,
  SEED_CONVERSATION_RESOLVED_ID,
  SEED_CONVERSATION_PENDING_ID,
  SEED_CONVERSATION_BRAND2_ID,
  SEED_CONVERSATION_UNASSIGNED_ID,
  SEED_LABEL_ID_2,
  SEED_MACRO_ID,
  SEED_MACRO_ASSIGN_ID,
  SEED_CANNED_RESPONSE_ID,
  SEED_MESSAGE_PLAYER_ID,
  SEED_MESSAGE_REPLY_ID,
  SEED_MESSAGE_NOTE_ID,
  // feature 014 (roadmap 4.6/4.7).
  SEED_AUTOMATION_KEYWORD_ID,
  SEED_AUTOMATION_ASSIGN_ID,
  SEED_AUTOMATION_SELF_ID,
  SEED_AUTOMATION_BREACH_ID,
  SEED_AUTOMATION_KEYWORD,
  SEED_SLA_POLICY_ID,
  SEED_SLA_TARGET_MINUTES,
  SEED_CONVERSATION_SLA_ID,
  SEED_AUTH_USER_ID,
} from '@crm/common';

/**
 * Pure synthetic dataset for chats_db (feature 008). No I/O — unit-testable (Track A). Exercises the
 * reserved classification fields (ADR 0027) + the player_id feed key + a private (internal) note.
 * brand_id / player_id / assignee_operator_id are soft refs (resolved via gRPC, never joined).
 */
export function buildSeed() {
  return {
    labels: [
      { id: SEED_LABEL_ID, account_id: SEED_ACCOUNT_ID, name: 'seed-demo' },
      // feature 013 (US2): a second label so attach/detach has a target that is NOT already linked.
      { id: SEED_LABEL_ID_2, account_id: SEED_ACCOUNT_ID, name: 'seed-followup' },
    ],
    conversations: [
      {
        id: SEED_CONVERSATION_OPEN_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'high', // feature 012: exercise priority filtering (4.1)
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null, // unclassified is valid (reserved, ADR 0027)
        classified_by: null as string | null,
      },
      {
        id: SEED_CONVERSATION_PENDING_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'pending', // feature 012: mixed lifecycle status for list filtering (4.1)
        priority: 'normal',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
      },
      {
        id: SEED_CONVERSATION_RESOLVED_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'resolved',
        priority: 'low',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: 'billing',
        classified_by: 'seed',
      },
      {
        // feature 013 (US1): starts with NO assignee — the assign/reassign/unassign fixture.
        id: SEED_CONVERSATION_UNASSIGNED_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
      },
      {
        // feature 014 (US2): the first-reply SLA fixture — no messages yet, so the Track-B script
        // drives its clock from a known-empty state (inbound starts it, a public reply stops it).
        id: SEED_CONVERSATION_SLA_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
      },
      {
        // feature 012 (US3): SAME player, a SECOND brand — proves the player brand-union in the
        // feed (one player_id spanning brands within the account; never crosses accounts).
        id: SEED_CONVERSATION_BRAND2_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID_2,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
      },
    ],
    messages: [
      {
        id: SEED_MESSAGE_PLAYER_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'Hello, I need help with my account.',
        private: false,
      },
      {
        id: SEED_MESSAGE_REPLY_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Happy to help — could you share more detail?',
        private: false,
      },
      {
        id: SEED_MESSAGE_NOTE_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Internal note: check the player segment.',
        private: true, // private note — excluded from the CUSTOMER projection at query (SEC-13)
        mentions: [SEED_OPERATOR_ID], // feature 012: @mention capture on a private note (R6)
      },
    ],
    conversationLabels: [{ conversation_id: SEED_CONVERSATION_OPEN_ID, label_id: SEED_LABEL_ID }],
    // feature 013 (US2): macro definitions use the v1 action shape {actions:[{type,value}]} with
    // wire-name values (research R4) — validated at define AND apply.
    macros: [
      {
        id: SEED_MACRO_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-triage',
        definition: {
          actions: [
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
          ],
        } as unknown,
      },
      {
        // Contains an ASSIGN action: applying it requires crm.conversation.assign as well, so it is
        // the all-or-nothing / permission-blocked fixture (SC-004).
        id: SEED_MACRO_ASSIGN_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-triage-and-assign',
        definition: {
          actions: [
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
            { type: 'MACRO_ACTION_TYPE_ASSIGN', value: SEED_OPERATOR_ID },
          ],
        } as unknown,
      },
    ],
    // feature 014 (US1/US3): rule definitions use {trigger, conditions, actions} with wire-name
    // values, validated at author AND at run time. `author_user_id` is the authority each rule acts
    // with — the seed user, who holds the supervisory keys (FR-023).
    automations: [
      {
        // The keyword rule: an inbound message on an UNASSIGNED conversation mentioning the keyword
        // gets labelled and moved to pending. Exercises a condition that reads message text without
        // ever storing it (FR-020).
        id: SEED_AUTOMATION_KEYWORD_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-keyword-triage',
        active: true,
        position: 0,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
          conditions: [
            { field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' },
            {
              field: 'CONDITION_FIELD_MESSAGE_TEXT',
              op: 'CONDITION_OP_CONTAINS',
              value: SEED_AUTOMATION_KEYWORD,
            },
          ],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
          ],
        } as unknown,
      },
      {
        // Contains an ASSIGN action ⇒ needs crm.conversation.assign from its AUTHOR. Revoking that
        // key from the author must leave the conversation completely unchanged (SC-002/SC-011).
        // Inactive by default so it only fires when the Track-B script enables it.
        id: SEED_AUTOMATION_ASSIGN_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-keyword-assign',
        active: false,
        position: 1,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
          conditions: [
            {
              field: 'CONDITION_FIELD_MESSAGE_TEXT',
              op: 'CONDITION_OP_CONTAINS',
              value: SEED_AUTOMATION_KEYWORD,
            },
          ],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_ASSIGN', value: SEED_OPERATOR_ID },
          ],
        } as unknown,
      },
      {
        // DELIBERATELY self-satisfying: triggered by a status change, and its action IS a status
        // change. Under a naive design this loops forever; here it cannot, because only controllers
        // publish events (FR-006 / SC-004). Inactive by default — enabled by the Track-B scenario.
        id: SEED_AUTOMATION_SELF_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-self-satisfying',
        active: false,
        position: 2,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
          conditions: [],
          actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' }],
        } as unknown,
      },
      {
        // The US3 join: reacts to a missed first-reply target (label + raise priority).
        id: SEED_AUTOMATION_BREACH_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-breach-escalation',
        active: true,
        position: 3,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
          conditions: [],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
          ],
        } as unknown,
      },
    ],
    // feature 014 (US2): one account-level target ('*'/'*' = any priority, any brand). Short on
    // purpose so a breach is observable within seconds on Track B (SC-006).
    slaPolicies: [
      {
        id: SEED_SLA_POLICY_ID,
        account_id: SEED_ACCOUNT_ID,
        target_minutes: SEED_SLA_TARGET_MINUTES,
        scope_priority: '*',
        scope_brand_id: '*',
      },
    ],
    cannedResponses: [
      {
        id: SEED_CANNED_RESPONSE_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-greeting',
        body: 'Thanks for reaching out — I am looking into this now.',
      },
    ],
  };
}

export type ChatsSeed = ReturnType<typeof buildSeed>;
