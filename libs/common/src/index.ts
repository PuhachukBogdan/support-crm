/**
 * @crm/common — shared TypeScript types/utilities for the CRM monorepo.
 *
 * Phase 0 seeded cross-workspace linking + conventions. Phase 1 (spec 003-local-infra)
 * adds the gRPC transport helpers, health/readiness types, and the config loader
 * (refuse-to-start, SEC-6). No product/domain logic here.
 */
export * from './grpc';
export * from './health';
export * from './config';
export * from './account-scope';
export * from './seed-constants';
export * from './policy';
export * from './audit';
export * from './transitions';
// Feature 016 (roadmap 4.9): the upload purpose catalogue, magic-byte detection and filename
// sanitising — shared by the gateway (parse limit, first tier) and users (enforcement).
export * from './uploads';
// Feature 017 (roadmap 4.10): the export scope catalogue + the CSV serializer — shared by the
// gateway (scope validation, permission key) and chats (production).
export * from './exports';
// Shared infrastructure for STRUCTURAL GUARDS (not product code, not run by any service). Extracted
// on 2026-07-29 when two guards written the same afternoon both needed comment-stripping: a guard
// that bans a token from the source must not ban it from the comment that documents its removal.
export * from './testing';
// Feature 021 (roadmap 5.6): the operator UI-preference catalogue — the OPERATOR's appearance
// settings, never `Player.preferences_json` (the customer's VIP portfolio data, tier `am_only`).
export * from './preferences';
// Feature 025 (roadmap 5.9): the presence vocabulary and the availability matrix — shared by users
// (which owns the state) and chats (which asks the question). ⚠️ "presence STATE", never "status",
// and never `Operator.active`, which means something else entirely (roadmap 3.16).
export * from './presence';
// Feature 032 (roadmap 4.16, ADR 0040): the closed status-CATEGORY catalogue + the seeded status set.
// ⚠️ Categories are code; STATUSES are per-account rows in chats_db. Nothing branches on a status key.
export * from './statuses';
// Feature 033 (roadmap 6.1/6.4/6.6, subpoint 2.1e): the closed channel-KIND vocabulary + the
// capability matrix. ⚠️ Same two-level discipline as statuses — a KIND is code and the only thing
// logic may branch on; a CHANNEL is a per-account row with a key, an address and a brand.
// `canSend` is an enforcement point called by the server, not a hint for the interface.
export * from './channels';
// Feature 037 (roadmap 4.15, W30): the closed ticket-field TYPE catalogue — types are code; field
// definitions, option sets, forms and their values are per-account rows in chats_db. ⚠️ These are
// TICKET fields on `Conversation`, never `Player.custom_attributes` (the customer's tiered
// portfolio data) — "the roadmap-4.15 failure shape" was exactly that confusion.
export * from './fields';
// Feature 033 (channels) + 038 (staff provisioning): the ONE signed-request verifier. Moved here
// when the second consumer arrived — a verifier that exists twice drifts, and the copy that drifts
// is the one nobody re-reads. ⚠️ The gateway still verifies nothing: the secret belongs to the
// owning service's data, so the edge forwards raw bytes and decides nothing.
export * from './signing';
// Feature 038 (roadmap 3.15, ADR 0043 §5): the fail-closed inbound address allow-list. ⚠️ Its empty
// list DENIES, unlike the outbound mail guard's — an inbound credential nobody configured addresses
// for is one nobody decided to trust. Both defaults are right for their own boundary.
export * from './net';
// Feature 034 (roadmap 7.1, subpoint 2.2a — MVP block W4): the realtime event vocabulary and the ONE
// account-channel builder. ⚠️ The payload is four identifiers and carries no content, deliberately: a
// socket is a second read path, and the only way it cannot bypass the REST read rules is by not being
// a read path. There is no tenant-less channel name to build.
export * from './realtime/events';
// Feature 034: the envelope-free error diagnostic, shared because it was written in the worker and
// needed again by chats the same day — two copies of a detector is one copy that is wrong.
export * from './observability/diagnose';
// Feature 028's mail transport, MOVED here by feature 033 (research R7): the port, the SMTP sender and
// the two egress guards, so the boundary Principle III depends on is one place rather than one per
// sender. ⚠️ Carries the `nodemailer` dependency — safe because nothing in `web/` imports this package;
// were that to change, this barrel would be the wrong door for it.
export * from './mail';
// Feature 018 (roadmap 5.1): keyset paging primitives. ⚠️ `services/chats/src/shared/cursor.ts` is a
// second, service-local copy of the same shape that predates this one and was deliberately not
// migrated (research R6) — a pointer sits in both files.
export * from './paging';
// Re-export zod so services build their config schemas without each declaring the dep.
export { z } from 'zod';

/** The canonical set of backend microservices (ADR 0029). */
export const SERVICE_NAMES = [
  'gateway',
  'auth',
  'users',
  'chats',
  'brands',
  'worker',
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

/** No-op helper — placeholder shared util used by the linking smoke test. */
export function noop(): void {
  /* intentionally empty */
}

/**
 * Structured-logging convention seed (Principle IV — no PII in logs).
 * A thin, dependency-free line logger later phases can replace with a real logger.
 * NEVER pass request bodies or user PII as `meta`.
 */
export function logInfo(service: ServiceName, message: string, meta?: Record<string, unknown>): void {
  const line: Record<string, unknown> = { level: 'info', service, message };
  if (meta) line.meta = meta;
  // Phase-0 placeholder logger; replaced by a structured logger in a later phase.
  console.log(JSON.stringify(line));
}
