import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_PLAYER_ID,
  SEED_OPERATOR_ID,
  SEED_LABEL_ID,
  SEED_CONVERSATION_OPEN_ID,
  SEED_CONVERSATION_RESOLVED_ID,
  SEED_MESSAGE_PLAYER_ID,
  SEED_MESSAGE_REPLY_ID,
  SEED_MESSAGE_NOTE_ID,
} from '@crm/common';

/**
 * Pure synthetic dataset for chats_db (feature 008). No I/O — unit-testable (Track A). Exercises the
 * reserved classification fields (ADR 0027) + the player_id feed key + a private (internal) note.
 * brand_id / player_id / assignee_operator_id are soft refs (resolved via gRPC, never joined).
 */
export function buildSeed() {
  return {
    labels: [{ id: SEED_LABEL_ID, account_id: SEED_ACCOUNT_ID, name: 'seed-demo' }],
    conversations: [
      {
        id: SEED_CONVERSATION_OPEN_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null, // unclassified is valid (reserved, ADR 0027)
        classified_by: null as string | null,
      },
      {
        id: SEED_CONVERSATION_RESOLVED_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'resolved',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: 'billing',
        classified_by: 'seed',
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
        private: true, // private note — realtime-scoping enforced later (SEC-13)
      },
    ],
    conversationLabels: [{ conversation_id: SEED_CONVERSATION_OPEN_ID, label_id: SEED_LABEL_ID }],
  };
}

export type ChatsSeed = ReturnType<typeof buildSeed>;
