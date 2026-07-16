// Shared types for the data/state layer (C). Transport-agnostic — see
// specs/004-ui-data-composites/contracts/data-access-interface.md.

/** Resource identifier (e.g. 'records'). Open string until the gateway contract lands. */
export type ResourceName = string;

/** Enforced upper bound on page size (Principle VII). */
export const MAX_PAGE_SIZE = 100;

/** A keyset list request. NOTE: cursor-based only — there is intentionally no `offset`. */
export interface Query {
  cursor?: string | null;
  limit: number;
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  filters?: Record<string, unknown>;
  /** Tenant/brand scope — carried now so the real impl enforces isolation server-side. */
  scope?: { accountId?: string; brandId?: string };
}

/** A page of results. NOTE: no `total` — exact COUNT on large tables is disallowed. */
export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Sanitized error that may cross into the UI — never a raw body/token/PII. */
export interface DataError {
  message: string;
  retryable: boolean;
  code?: string;
}

/** The one shared view state every data-backed view renders from. */
export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; error: DataError }
  | { status: 'ready'; data: T };
