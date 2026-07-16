/**
 * Shared health/readiness types (spec 003-local-infra, US5 / data-model.md).
 *
 * Two layers:
 *  - wire (gRPC `HealthService.Check`): `ServingStatus` strings, see health.proto.
 *  - REST readiness aggregate (gateway `GET /health/ready`): the `ReadinessDto` below.
 * No product data / PII crosses either — status only (Principle IV).
 */

/** gRPC-level per-dependency / per-service state (health.proto `status` fields). */
export type ServingStatus = 'SERVING' | 'NOT_SERVING';

/** REST-level per-dependency state exposed in the readiness aggregate. */
export type ReadinessState = 'ok' | 'degraded' | 'n/a';

/** One row of the readiness aggregate — a service and the dependencies it owns. */
export interface DependencyReport {
  service: string;
  /** `n/a` for services that own no relational DB (gateway, worker). */
  postgres: ReadinessState;
  /** `n/a` for services that use no cache/queue store. */
  redis: ReadinessState;
  /** Did the service's gRPC `Check` return within the deadline. */
  reachable: boolean;
}

/** The gateway's readiness aggregate DTO (`GET /health/ready`). */
export interface ReadinessDto {
  status: 'ok' | 'degraded';
  checkedAt: string;
  dependencies: DependencyReport[];
}

/**
 * Run a dependency probe and map success/failure to a serving status. Dependency-light
 * (takes a thunk) so `@crm/common` stays free of prisma/ioredis. Never rethrows — a
 * downed dependency is reported, not crashed on (FR-012).
 */
export async function probeServing(fn: () => Promise<unknown>): Promise<ServingStatus> {
  try {
    await fn();
    return 'SERVING';
  } catch {
    return 'NOT_SERVING';
  }
}

/** Map a gRPC serving status to a REST readiness state. */
export function servingToState(status: ServingStatus): ReadinessState {
  return status === 'SERVING' ? 'ok' : 'degraded';
}

/**
 * Compose the overall aggregate from per-service rows: `ok` iff every row is reachable
 * and no owned dependency is `degraded`; otherwise `degraded`.
 */
export function aggregateReadiness(deps: DependencyReport[], checkedAt: string): ReadinessDto {
  const healthy = deps.every(
    (d) => d.reachable && d.postgres !== 'degraded' && d.redis !== 'degraded',
  );
  return { status: healthy ? 'ok' : 'degraded', checkedAt, dependencies: deps };
}
