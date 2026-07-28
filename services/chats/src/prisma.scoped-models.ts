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
  // Feature 015 (roadmap 4.8): the general audit trail. Identical model in all three services —
  // the table cannot be shared (Principle VIII) and the entry lives in its action's transaction.
  'AuditEntry',
  // Feature 016 (roadmap 4.9): the message→upload link. Carries account_id of its own even though
  // it hangs off Message — an attachment must be unreachable across the boundary on its own terms,
  // not only through its parent.
  'MessageAttachment',
  // Feature 017 (roadmap 4.10): one data export. Same exception shape as ConversationSlaState above —
  // the maintenance sweeps (RunDueExports / ExpireDueExports) read by status at the METHOD level, so
  // every other access to this table stays fail-closed through forAccount.
  'ExportJob',
] as const;
