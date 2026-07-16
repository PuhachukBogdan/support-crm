import type { DataAccess, ResourceName } from '../data-access';
import type { Query, PaginatedResult, DataError } from '../types';
import { MAX_PAGE_SIZE } from '../types';
import { makeDemoRecords, type DemoRecord } from './demo-data';

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

    // Equality filters (unknown keys ignored).
    if (query.filters) {
      for (const [key, value] of Object.entries(query.filters)) {
        if (value == null) continue;
        rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[key] === value);
      }
    }

    // Sort (default by id asc → stable keyset).
    const sort = query.sort?.[0] ?? { field: 'id', dir: 'asc' as const };
    rows.sort((a, b) => {
      const av = String((a as unknown as Record<string, unknown>)[sort.field] ?? '');
      const bv = String((b as unknown as Record<string, unknown>)[sort.field] ?? '');
      return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    // Keyset: start immediately AFTER the cursor row (never an offset scan).
    let start = 0;
    if (query.cursor) {
      const idx = rows.findIndex((r) => r.id === query.cursor);
      start = idx >= 0 ? idx + 1 : rows.length;
    }
    const limit = Math.max(1, Math.min(query.limit, MAX_PAGE_SIZE));
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
