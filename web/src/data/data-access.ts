import type { Query, PaginatedResult, ResourceName } from './types';

/**
 * The typed, transport-agnostic data boundary (the "C" contract). Screens and composites
 * depend ONLY on this interface — never on `src/api` or `fetch`. Implementations are
 * interchangeable: MockDataAccess (now) and GatewayDataAccess (later), swapped behind
 * DataAccessProvider with no consumer change (SC-001).
 */
export interface DataAccess {
  list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>>;
  get<T = unknown>(resource: ResourceName, id: string): Promise<T>;
  create<T = unknown>(resource: ResourceName, input: unknown): Promise<T>;
  update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T>;
  remove(resource: ResourceName, id: string): Promise<void>;
}

export type { ResourceName } from './types';
