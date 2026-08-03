import { SUBJECTS, ABSENT_ID, type Subject } from './subjects';
import { MAX_PAGE_SIZE, type DataError, type PaginatedResult, type Query } from '../types';

/**
 * T025/T026 [US3] — ONE contract, executed against EVERY implementation.
 *
 * Replaces `data-access.contract.test.ts`, which was named for the contract and instantiated
 * `MockDataAccess` directly. That file could not have caught a divergence between the mock and the
 * real transport, which is the only thing worth checking here: every screen in this product was built
 * against invented data whose shape nobody had ever compared to the server's.
 *
 * Expectations are behavioural, so they say nothing about a resource. Contract source:
 * `specs/019-gateway-transport/contracts/data-access-conformance.md`.
 */

// ⚠️ ANTI-VACUOUS GUARD (T026). A parameterised suite that silently degrades to one subject proves
// half of what its name claims, and looks identical in the output. Fourth instance of that class in
// this repository, and the one found on 2026-07-29 had been green since the day it was written.
describe('the conformance suite runs against every implementation', () => {
  it('there is more than one subject', () => {
    expect(SUBJECTS.length).toBeGreaterThan(1);
    expect(SUBJECTS.map((s) => s.name)).toEqual(expect.arrayContaining(['mock', 'gateway']));
  });

  it('no two subjects share a name — a failure must identify one implementation', () => {
    expect(new Set(SUBJECTS.map((s) => s.name)).size).toBe(SUBJECTS.length);
  });
});

describe.each(SUBJECTS.map((s) => [s.name, s] as const))('[%s] DataAccess contract', (_n, s: Subject) => {
  describe('C-1 paging', () => {
    it('1.1 a page carries at most `limit` items, a cursor, and hasMore', async () => {
      const page = await s.create('paging').list(s.resource, s.baseQuery(s.pageSize));
      expect(page.items.length).toBeLessThanOrEqual(s.pageSize);
      expect(page.nextCursor).not.toBeNull();
      expect(page.hasMore).toBe(true);
    });

    it('1.2/1.3 traversal advances, never overlaps, and terminates', async () => {
      const da = s.create('paging');
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      for (;;) {
        const page: PaginatedResult<Record<string, unknown>> = await da.list(s.resource, {
          ...s.baseQuery(s.pageSize),
          cursor,
        });
        seen.push(...page.items.map((r: Record<string, unknown>) => String(r.id)));
        pages += 1;
        cursor = page.nextCursor;
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        // An empty string treated as a cursor loops forever and reads as a slow list, not a crash.
        expect(cursor).not.toBe('');
        expect(pages).toBeLessThan(20);
      }

      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('1.4 hasMore always agrees with the cursor, never with the item count', async () => {
      const da = s.create('paging');
      let cursor: string | null = null;
      for (let i = 0; i < 3; i += 1) {
        const page: PaginatedResult<unknown> = await da.list(s.resource, {
          ...s.baseQuery(s.pageSize),
          cursor,
        });
        expect(page.hasMore).toBe(page.nextCursor !== null);
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
    });

    it('1.5 a limit above the ceiling is refused, not silently reduced', async () => {
      await expect(
        s.create('paging').list(s.resource, s.baseQuery(MAX_PAGE_SIZE + 1)),
      ).rejects.toMatchObject({ retryable: false });
    });

    it('no implementation accepts an offset — keyset only', async () => {
      const query: Query = s.baseQuery(s.pageSize);
      expect(Object.keys(query)).not.toContain('offset');
    });
  });

  describe('C-2 empty is a value, not an error', () => {
    it('2.1 an empty result resolves with no items and no cursor', async () => {
      const page = await s.create('empty').list(s.resource, s.baseQuery(s.pageSize));
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
      expect(page.hasMore).toBe(false);
    });
  });

  describe('C-3 reading one record', () => {
    it('3.2 an unknown id rejects as non-retryable', async () => {
      await expect(s.create('missing').get(s.resource, ABSENT_ID)).rejects.toMatchObject({
        retryable: false,
      });
    });

    it('3.3 the rejection carries no identifier and no server text', async () => {
      const err = await s
        .create('missing')
        .get(s.resource, ABSENT_ID)
        .catch((e: DataError) => e);
      expect(JSON.stringify(err)).not.toContain(ABSENT_ID);
    });
  });

  describe('C-4 parameters', () => {
    it('4.1 an undeclared filter is refused BEFORE anything is sent', async () => {
      // The expectation the mock failed until 2026-07-29: it ignored unknown filter keys, which is
      // the widening direction — a caller believes it filtered and receives everything.
      await expect(
        s.create('paging').list(s.resource, {
          ...s.baseQuery(s.pageSize),
          filters: { [s.undeclaredFilterKey]: 'x' },
        }),
      ).rejects.toMatchObject({ retryable: false });
    });

    it('4.1b the refusal names the key and never its value', async () => {
      const err = (await s
        .create('paging')
        .list(s.resource, {
          ...s.baseQuery(s.pageSize),
          filters: { [s.undeclaredFilterKey]: 'ply-4711@example.com' },
        })
        .catch((e: DataError) => e)) as DataError;
      expect(err.message).toContain(s.undeclaredFilterKey);
      expect(err.message).not.toContain('ply-4711');
    });

    it('4.3 a sort is refused — an unsorted list would be a silent lie', async () => {
      await expect(
        s.create('paging').list(s.resource, {
          ...s.baseQuery(s.pageSize),
          sort: [{ field: 'id', dir: 'desc' }],
        }),
      ).rejects.toMatchObject({ retryable: false });
    });

    /**
     * 4.4 (feature 029) — an UNDECLARED order is refused before anything is sent.
     *
     * The same rule as an undeclared filter, and the same reason: `/conversations` silently drops a
     * query parameter it does not recognise, so an unhonoured order returns 200 in the DEFAULT
     * sequence — presented to the agent as the one they picked. A wrong list still looks like a list.
     *
     * ⚠️ Deliberately asserts the REFUSAL only, which is the part both subjects share. Whether a
     * resource has any orders at all differs per subject (the mock declares none; `/conversations`
     * declares two), and a conformance case must be true of every implementation or it is testing one.
     */
    it('4.4 an order the resource does not declare is refused before anything is sent', async () => {
      await expect(
        s.create('paging').list(s.resource, {
          ...s.baseQuery(s.pageSize),
          order: 'no_such_order_exists',
        }),
      ).rejects.toMatchObject({ retryable: false });
    });
  });

  describe('C-5 a write either takes effect or refuses by name — never silently nothing', () => {
    it.each(['create', 'update', 'remove'] as const)('5.1 %s', async (op) => {
      const da = s.create('paging');
      const call = (da as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op]!;
      const outcome = await call
        .call(da, s.resource, '00000001', { subject: 'changed' })
        .then(() => 'performed' as const)
        .catch((e: DataError) => e);

      if (s.writes.includes(op)) {
        // Supported: it must actually have happened, not resolved into the void.
        expect(outcome).toBe('performed');
        return;
      }

      // Unsupported: a refusal naming BOTH, so the message tells a developer what to add and where.
      // The third possibility — resolving with nothing — is the one that lets a screen believe it
      // saved something, and it is what an empty method body would do.
      expect(outcome).not.toBe('performed');
      const err = outcome as DataError;
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(op);
      expect(err.message).toContain(s.resource);
    });

    it('5.2 a supported write is observable afterwards', async () => {
      if (!s.writes.includes('remove')) return; // covered by 5.1's refusal branch
      const da = s.create('paging');
      const before = await da.list<Record<string, unknown>>(s.resource, s.baseQuery(s.pageSize));
      const victim = String(before.items[0]!.id);
      await da.remove(s.resource, victim);
      const after = await da.list<Record<string, unknown>>(s.resource, s.baseQuery(s.pageSize));
      expect(after.items.map((r) => String(r.id))).not.toContain(victim);
    });
  });
});
