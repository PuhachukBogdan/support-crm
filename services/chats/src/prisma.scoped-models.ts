/**
 * Account-scoped models in chats_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. The ConversationLabel join table is omitted: it carries no account_id and is
 * scoped through its in-schema parents. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts.
 */
export const SCOPED_MODELS = ['Conversation', 'Message', 'Label', 'Macro', 'Automation'] as const;
