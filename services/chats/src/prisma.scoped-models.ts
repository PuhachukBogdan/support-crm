/**
 * Account-scoped models in chats_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. The ConversationLabel join table is omitted: it carries no account_id and is
 * scoped through its in-schema parents. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts.
 */
export const SCOPED_MODELS = [
  'Conversation',
  'Message',
  'Label',
  'Macro',
  'Automation',
  // Feature 013 (roadmap 4.4/4.5).
  'CannedResponse',
  'RoundRobinState',
  // Feature 014 (roadmap 4.6/4.7). NOTE: ConversationSlaState is scoped like every other tenant
  // table — the sweep's single unscoped read (sla/sla-sweep.repository.ts) is an exception at the
  // METHOD level, deliberately not at the model level, so every other access stays fail-closed.
  'AutomationRun',
  'FirstReplySlaPolicy',
  'ConversationSlaState',
] as const;
