/**
 * @crm/common — shared TypeScript types/utilities for the CRM monorepo.
 *
 * Phase 0 content is intentionally trivial: enough to prove cross-workspace linking
 * (US1) and to seed conventions later phases inherit. No product/domain logic here.
 */

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
