/**
 * Synthetic seed fixtures (feature 008) — shared identifiers so the four per-service seeds form ONE
 * coherent graph and so upserts are idempotent (stable keys). Cross-service links are soft-ref VALUES
 * (no FK; resolved via gRPC at runtime).
 *
 * ⚠️ SYNTHETIC DEV FIXTURES — NOT used by runtime service code. All values are invented and
 * brand-neutral (Principles V/VI). No real company/customer data, no real secrets.
 */

// Tenant + brand + player seam (the graph's spine).
export const SEED_ACCOUNT_ID = 'seed-account-0000-0000-000000000001';
export const SEED_BRAND_ID = 'seed-brand-0000-0000-000000000001';
export const SEED_BRAND_SLUG = 'bow'; // neutral placeholder slug — no real identity
export const SEED_BRAND_ID_2 = 'seed-brand-0000-0000-000000000002'; // feature 012: player brand-union fixture
export const SEED_PLAYER_ID = 'seed-player-001';

// auth_db
export const SEED_AUTH_USER_ID = 'seed-user-0000-0000-000000000001';
export const SEED_ROLE_ID = 'seed-role-0000-0000-000000000001';
export const SEED_CREDENTIAL_ID = 'seed-cred-0000-0000-000000000001';
/** Labelled placeholder — obviously NOT a real or reversible secret (real auth = Phase 3). */
export const SEED_PLACEHOLDER_SECRET = 'SEED_PLACEHOLDER_NOT_A_REAL_HASH';

// users_db
export const SEED_OPERATOR_ID = 'seed-operator-0000-0000-000000000001';

// brands_db
export const SEED_BRAND_ACCESS_RULE_ID = 'seed-bar-0000-0000-000000000001';

// chats_db
export const SEED_LABEL_ID = 'seed-label-0000-0000-000000000001';
export const SEED_CONVERSATION_OPEN_ID = 'seed-conv-open-0000-000000000001';
export const SEED_CONVERSATION_RESOLVED_ID = 'seed-conv-resolved-0000-00000001';
export const SEED_CONVERSATION_PENDING_ID = 'seed-conv-pending-0000-000000001'; // feature 012: mixed-status fixture
export const SEED_CONVERSATION_BRAND2_ID = 'seed-conv-brand2-0000-000000001'; // feature 012: same player, 2nd brand (union)
// feature 013 (workflow, roadmap 4.4/4.5) fixtures.
/** Unassigned conversation — the assign/reassign/unassign fixture (US1). */
export const SEED_CONVERSATION_UNASSIGNED_ID = 'seed-conv-unassigned-0000-00001';
export const SEED_LABEL_ID_2 = 'seed-label-0000-0000-000000000002';
/** Macro with only self-contained actions (set status + add label). */
export const SEED_MACRO_ID = 'seed-macro-0000-0000-000000000001';
/** Macro containing an ASSIGN action — the permission-blocked / all-or-nothing fixture. */
export const SEED_MACRO_ASSIGN_ID = 'seed-macro-0000-0000-000000000002';
export const SEED_CANNED_RESPONSE_ID = 'seed-canned-0000-0000-00000000001';

export const SEED_MESSAGE_PLAYER_ID = 'seed-msg-0000-0000-000000000001';
export const SEED_MESSAGE_REPLY_ID = 'seed-msg-0000-0000-000000000002';
export const SEED_MESSAGE_NOTE_ID = 'seed-msg-0000-0000-000000000003';

// feature 014 (automations + first-reply SLA, roadmap 4.6/4.7) fixtures.
/** Keyword rule: inbound message + unassigned + text contains the keyword → label + status. */
export const SEED_AUTOMATION_KEYWORD_ID = 'seed-auto-0000-0000-000000000001';
/** Rule containing an ASSIGN action — the author-lacks-permission / zero-writes fixture. */
export const SEED_AUTOMATION_ASSIGN_ID = 'seed-auto-0000-0000-000000000002';
/** Deliberately self-satisfying rule (status changed → set status) — the no-cascade fixture. */
export const SEED_AUTOMATION_SELF_ID = 'seed-auto-0000-0000-000000000003';
/** Reacts to a first-reply breach — the US3 join fixture. */
export const SEED_AUTOMATION_BREACH_ID = 'seed-auto-0000-0000-000000000004';
/** The keyword the seeded rule matches on. Brand-neutral, obviously synthetic. */
export const SEED_AUTOMATION_KEYWORD = 'seedkeyword';
export const SEED_SLA_POLICY_ID = 'seed-sla-policy-0000-000000000001';
/** Short on purpose: a breach must be observable within seconds on Track B (SC-006). */
export const SEED_SLA_TARGET_MINUTES = 1;
/** Conversation used for the SLA scenarios — its clock is driven by the Track-B script. */
export const SEED_CONVERSATION_SLA_ID = 'seed-conv-sla-0000-00000000001';
