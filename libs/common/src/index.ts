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
