import type { DataAccess, ResourceName } from '../data-access';
import type { Query, PaginatedResult, DataError } from '../types';
import { MAX_PAGE_SIZE } from '../types';
import { makeDemoRecords, type DemoRecord } from './demo-data';

/**
 * The filters this resource declares. The gateway keeps the same knowledge in a registry row; here
 * one resource means one list. Anything outside it is refused rather than ignored (feature 019).
 */
const DEMO_FILTERS = ['status', 'priority', 'subject'] as const as readonly string[];

export interface MockOptions {
  /** Number of demo records to generate (default 50). */
  count?: number;
  /** Artificial latency (ms) so loading states are observable in tests. */
  delayMs?: number;
  /** Force every call to reject with this DataError (for error-state tests). */
  failWith?: DataError | null;
}

/**
 * In-memory DataAccess for frontend-only development (US1). Keyset pagination only;
 * synthetic data; no network. Swapped for GatewayDataAccess later behind the interface.
 */
export class MockDataAccess implements DataAccess {
  private records: DemoRecord[];
  private readonly delayMs: number;
  private readonly failWith: DataError | null;

  constructor(opts: MockOptions = {}) {
    this.records = makeDemoRecords(opts.count ?? 50);
    this.delayMs = opts.delayMs ?? 0;
    this.failWith = opts.failWith ?? null;
  }

  private async settle(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
  }

  async list<T = unknown>(_resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
    await this.settle();
    let rows: DemoRecord[] = [...this.records];

    /**
     * ⚠️ THREE REFUSALS ADDED 2026-07-29 (feature 019), each because the shared conformance suite
     * caught this class diverging from the real transport. Screens are built against this object;
     * every behaviour it has that the gateway does not is a screen that works on demo data and
     * breaks on real data — which is the entire risk the feature exists to close.
     *
     * The dangerous one was the first: unknown filter keys were **ignored**. A caller believed it
     * had filtered and received everything — the widening direction, and the same shape as the 017
     * live-run defect. The gateway refuses it; so must this.
     */
    if (query.sort && query.sort.length > 0) {
      // No route in the product accepts a sort. Sorting here would let a screen offer sortable
      // columns that silently stop sorting against the real API. When a route gains sorting, both
      // implementations gain it in the same change.
      throw { message: 'sorting is not supported by this resource', retryable: false, code: 'invalid-request' } satisfies DataError;
    }
    if (query.limit > MAX_PAGE_SIZE) {
      // Refused, not clamped: a silently reduced page teaches the caller the parameter is advisory.
      throw { message: `limit must not exceed ${MAX_PAGE_SIZE}`, retryable: false, code: 'invalid-request' } satisfies DataError;
    }

    // Equality filters. An UNDECLARED key is refused — never ignored, never silently dropped.
    if (query.filters) {
      for (const [key, value] of Object.entries(query.filters)) {
        if (!DEMO_FILTERS.includes(key)) {
          // The KEY is named, never its value: a filter value can be a customer identifier.
          throw { message: `unknown filter for this resource: ${key}`, retryable: false, code: 'invalid-request' } satisfies DataError;
        }
        if (value == null || value === '') continue;
        rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[key] === value);
      }
    }

    // Stable keyset ordering by id, matching the ids' zero-padded, sortable shape.
    rows.sort((a, b) => a.id.localeCompare(b.id));

    // Keyset: start immediately AFTER the cursor row (never an offset scan).
    let start = 0;
    if (query.cursor) {
      const idx = rows.findIndex((r) => r.id === query.cursor);
      start = idx >= 0 ? idx + 1 : rows.length;
    }
    const limit = Math.max(1, query.limit);
    const page = rows.slice(start, start + limit);
    const nextCursor = start + limit < rows.length ? (page[page.length - 1]?.id ?? null) : null;

    return { items: page as T[], nextCursor, hasMore: nextCursor !== null };
  }

  async get<T = unknown>(_resource: ResourceName, id: string): Promise<T> {
    await this.settle();
    const found = this.records.find((r) => r.id === id);
    if (!found) throw { message: 'Not found', retryable: false, code: 'NOT_FOUND' } satisfies DataError;
    return found as T;
  }

  async create<T = unknown>(_resource: ResourceName, input: unknown): Promise<T> {
    await this.settle();
    const rec = input as DemoRecord;
    this.records.push(rec);
    return rec as T;
  }

  async update<T = unknown>(_resource: ResourceName, id: string, patch: unknown): Promise<T> {
    await this.settle();
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) throw { message: 'Not found', retryable: false, code: 'NOT_FOUND' } satisfies DataError;
    const updated = { ...this.records[i]!, ...(patch as object) } as DemoRecord;
    this.records[i] = updated;
    return updated as T;
  }

  async remove(_resource: ResourceName, id: string): Promise<void> {
    await this.settle();
    this.records = this.records.filter((r) => r.id !== id);
  }
}
