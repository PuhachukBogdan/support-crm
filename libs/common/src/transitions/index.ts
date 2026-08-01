/**
 * The transition vocabulary (feature 023, roadmap 4.8a — ADR 0046).
 *
 * Shared in `libs/common` for the same reason the audit catalogue is: the reserved writers live in
 * other services (presence in users, provisioning in auth). The VOCABULARY is shared; the TABLE stays
 * per service (Principle VIII / ADR 0029 — no shared cross-service store).
 */
export * from './catalogue';
export * from './payload';
// Feature 025 (roadmap 5.9): the row SHAPE, shared once `users` became the second writer. The
// vocabulary was always shared; now the envelope is too, because "identical" written twice by hand
// is "identical until somebody edits one of them" (FR-004).
export * from './row';
