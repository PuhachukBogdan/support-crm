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
  // feature 022 (roadmap 4.13): the contact-history fixtures — a system entry, a recorded channel, and the
  // explicitly linked cross-brand person.
  SEED_MESSAGE_SYSTEM_ID,
  SEED_CONVERSATION_LINKED_A_ID,
  SEED_CONVERSATION_LINKED_B_ID,
  SEED_MESSAGE_LINKED_A_ID,
  SEED_MESSAGE_LINKED_B_ID,
  SEED_MESSAGE_LINKED_B_REPLY_ID,
  SEED_PLAYER_LINKED_A,
  SEED_PLAYER_LINKED_B,
  SEED_CHANNEL_EMAIL,
  SEED_CHANNEL_API,
} from '@crm/common';
// Feature 022 (roadmap 4.13): the seed derives its contact stamps with the PRODUCTION rule. Importing it
// is the point — a copy here would be a third statement of the same fact (after the code and the
// migration's SQL), and the copies would drift silently.
import { decideContactStamp } from '../src/message/contact-stamp';

/**
 * Pure synthetic dataset for chats_db (feature 008). No I/O — unit-testable (Track A). Exercises the
 * reserved classification fields (ADR 0027) + the player_id feed key + a private (internal) note.
 * brand_id / player_id / assignee_operator_id are soft refs (resolved via gRPC, never joined).
 */
/**
 * Fixed message timestamps (feature 022). Explicit rather than `now()` at seed time, for two reasons:
 * the derived contact stamps below must equal the messages they come from, and Track B compares a value
 * read from Postgres against the same value from the API — a moving fixture makes that comparison a
 * coin toss.
 */
export const SEED_MESSAGE_PLAYER_AT = new Date('2026-07-20T09:00:00.000Z');
export const SEED_MESSAGE_REPLY_AT = new Date('2026-07-20T09:15:00.000Z');
/** LATER than the public reply on purpose: a private note must not become the last outbound contact. */
export const SEED_MESSAGE_NOTE_AT = new Date('2026-07-20T09:30:00.000Z');
/** LATER than everything else on that conversation: a system entry must not become contact either. */
export const SEED_MESSAGE_SYSTEM_AT = new Date('2026-07-20T09:45:00.000Z');

/** The linked person's contact — the second brand is LATER, so the person-level maximum comes from it. */
export const SEED_MESSAGE_LINKED_A_AT = new Date('2026-07-23T10:00:00.000Z');
export const SEED_MESSAGE_LINKED_B_AT = new Date('2026-07-24T10:00:00.000Z');
export const SEED_MESSAGE_LINKED_B_REPLY_AT = new Date('2026-07-24T10:30:00.000Z');

/**
 * Derive each conversation's contact stamps from its own messages, using the PRODUCTION rule
 * (`decideContactStamp`) — never a copy of it.
 *
 * ── Why the seed has to do this at all (research R3) ─────────────────────────────────────────────
 * `seed.ts` writes messages with `message.upsert`, bypassing `MessageRepository.post` — the one place
 * that maintains the stamps. So seeded conversations would carry NULLs and every seeded card would read
 * "never contacted" while its thread visibly contains messages. **Track B runs on this seed**, so that
 * would have surfaced as a product defect that was really a fixture defect (feature 018's lesson, one
 * field over).
 *
 * ── Why derived rather than written into each fixture by hand ────────────────────────────────────
 * A hand-written stamp is a second statement of the same fact, and the two would drift the first time
 * someone adds a message to an existing conversation fixture — silently, because nothing would fail.
 * `seed.build.spec.ts` asserts this derivation against the fixtures, which is the same property
 * `migration-022.spec.ts` asserts for the backfill and Track B asserts for live rows.
 */
export function deriveContactStamps<
  C extends { id: string },
  M extends { conversation_id: string; author_type: string; private?: boolean; created_at: Date },
>(conversations: C[], messages: M[]) {
  return conversations.map((c) => {
    const stamps: { last_inbound_at: Date | null; last_outbound_at: Date | null } = {
      last_inbound_at: null,
      last_outbound_at: null,
    };
    for (const m of messages) {
      if (m.conversation_id !== c.id) continue;
      const column = decideContactStamp(m.author_type, m.private ?? false);
      if (!column) continue; // a private note and a system entry are inert (SEC-13 / roadmap 4.7)
      const current = stamps[column];
      if (!current || m.created_at > current) stamps[column] = m.created_at;
    }
    return { ...c, ...stamps };
  });
}

export function buildSeed() {
  const seed = {
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
        // Feature 022: the ONLY conversation of this player with a RECORDED channel. Its siblings carry
        // none (the state the whole existing history is in until Phase 6), so the rollup has a named entry
        // next to the unrecorded bucket — which is what makes "the per-channel counts sum to the total" a
        // real assertion rather than a trivially true one.
        channel: SEED_CHANNEL_EMAIL as string | null,
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
      /**
       * ── Feature 022 (roadmap 4.13): the LINKED person's two conversations, one per brand ────────
       *
       * Two DISTINCT platform ids (not the collision pair), explicitly linked into one person in users_db.
       * Contact lands at different times under each brand, so the person-level read is falsifiable: if it
       * quietly answered the player-level question, the later timestamp would be missing.
       */
      {
        id: SEED_CONVERSATION_LINKED_A_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_LINKED_A,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
        channel: SEED_CHANNEL_EMAIL as string | null,
      },
      {
        id: SEED_CONVERSATION_LINKED_B_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID_2,
        player_id: SEED_PLAYER_LINKED_B,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
        // A DIFFERENT channel from the other brand's, so "they write on one channel and we answer on
        // another" is observable across the person's records rather than only in theory.
        channel: SEED_CHANNEL_API as string | null,
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
        created_at: SEED_MESSAGE_PLAYER_AT, // feature 022 — fixed, so the derived stamp is deterministic
      },
      {
        id: SEED_MESSAGE_REPLY_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Happy to help — could you share more detail?',
        private: false,
        created_at: SEED_MESSAGE_REPLY_AT,
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
        // Feature 022: later than the public reply on purpose. If a private note ever counted as contact,
        // `last_outbound_at` would be 09:30 instead of 09:15 — the fixture makes that mistake visible
        // instead of harmless.
        created_at: SEED_MESSAGE_NOTE_AT,
      },
      {
        /**
         * Feature 022 — a SYSTEM entry, and it is the LATEST message on this conversation.
         *
         * Machine output is not a conversation with the customer. Because this row is newer than both the
         * reply (09:15) and the note (09:30), counting it as contact would CHANGE the card's answer to
         * 09:45 rather than leave it alone — so the live run can tell the difference. A fixture that only
         * ever produced the same answer either way would prove nothing.
         */
        id: SEED_MESSAGE_SYSTEM_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'system',
        author_id: null as string | null,
        body: 'Conversation reopened by the seed fixture.',
        private: false,
        created_at: SEED_MESSAGE_SYSTEM_AT,
      },
      // ── The linked person's contact, one message per brand ────────────────────────────────────
      {
        id: SEED_MESSAGE_LINKED_A_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_A_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_LINKED_A,
        body: 'Writing from the first brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_A_AT,
      },
      {
        // LATER than the first brand's, so the person-level maximum can only come from this record.
        id: SEED_MESSAGE_LINKED_B_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_B_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_LINKED_B,
        body: 'Writing from the second brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_B_AT,
      },
      {
        // …and a reply under the second brand only, so "they write on one channel, we answer on another"
        // is visible in the person's rollup.
        id: SEED_MESSAGE_LINKED_B_REPLY_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_B_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Answered under the second brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_B_REPLY_AT,
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

  // Feature 022: the conversations carry their contact stamps, derived from the messages above by the
  // production rule. Applied here rather than inside the literal so a new message fixture cannot leave a
  // stale stamp behind — there is nothing to update.
  return { ...seed, conversations: deriveContactStamps(seed.conversations, seed.messages) };
}

export type ChatsSeed = ReturnType<typeof buildSeed>;
