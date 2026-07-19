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
export const SEED_MESSAGE_PLAYER_ID = 'seed-msg-0000-0000-000000000001';
export const SEED_MESSAGE_REPLY_ID = 'seed-msg-0000-0000-000000000002';
export const SEED_MESSAGE_NOTE_ID = 'seed-msg-0000-0000-000000000003';
