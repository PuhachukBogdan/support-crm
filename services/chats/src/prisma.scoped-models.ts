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
  // Feature 023 (roadmap 4.8a): the append-only transition stream. Scoped like every other tenant
  // table, with the SAME method-level exception shape as ConversationSlaState and ExportJob above:
  // `transition/transition.repository.ts` reads unscoped for the health report.
  //
  // ⚠️ CORRECTED 2026-08-01, same day it was written. This comment first claimed there was "no
  // method-level exception, because nothing reads transitions across accounts" — and then the health
  // report turned out to be exactly such a read. It is the weakest exception of the three (COUNTS and
  // one timestamp, no ids at all, no writes follow), but it is one, and saying otherwise would have
  // left a false statement in the place a reader checks first. The project's own rule: when a
  // guarantee holds, check WHICH code makes it hold.
  'ConversationTransition',
  // Feature 032 (roadmap 4.16): the per-account status catalogue. Scoped like every other tenant table
  // and with NO method-level exception at all — every read of it happens for a caller, in that caller's
  // account, so there is nothing here that resembles the three sweeps above.
  'ConversationStatus',
] as const;
