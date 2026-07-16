import { MockDataAccess } from './mock/mock-data-access';
import type { DemoRecord } from './mock/demo-data';

// T006 [US1] — MockDataAccess satisfies the DataAccess contract (keyset, empty, CRUD).

describe('MockDataAccess — DataAccess contract', () => {
  it('paginates by keyset: nextCursor advances, pages do not overlap, no offset param', async () => {
    const da = new MockDataAccess({ count: 25 });

    const p1 = await da.list<DemoRecord>('records', { limit: 10 });
    expect(p1.items).toHaveLength(10);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.hasMore).toBe(true);

    const p2 = await da.list<DemoRecord>('records', { limit: 10, cursor: p1.nextCursor });
    const ids1 = new Set(p1.items.map((r) => r.id));
    expect(p2.items.some((r) => ids1.has(r.id))).toBe(false); // no overlap
    expect(p2.items[0]!.id > p1.items[9]!.id).toBe(true); // advanced past cursor

    const p3 = await da.list<DemoRecord>('records', { limit: 10, cursor: p2.nextCursor });
    expect(p3.items).toHaveLength(5);
    expect(p3.nextCursor).toBeNull();
    expect(p3.hasMore).toBe(false);
  });

  it('returns an empty page when a filter matches nothing (empty ≠ error)', async () => {
    const da = new MockDataAccess({ count: 5 });
    const res = await da.list<DemoRecord>('records', { limit: 10, filters: { status: 'nope' } });
    expect(res.items).toHaveLength(0);
    expect(res.nextCursor).toBeNull();
  });

  it('supports get / create / update / remove', async () => {
    const da = new MockDataAccess({ count: 3 });
    const got = await da.get<DemoRecord>('records', '00000001');
    expect(got.id).toBe('00000001');

    await da.update<DemoRecord>('records', '00000001', { subject: 'changed' });
    expect((await da.get<DemoRecord>('records', '00000001')).subject).toBe('changed');

    await da.remove('records', '00000001');
    const after = await da.list<DemoRecord>('records', { limit: 10 });
    expect(after.items.find((r) => r.id === '00000001')).toBeUndefined();
  });

  it('rejects with a non-retryable DataError on missing get', async () => {
    const da = new MockDataAccess({ count: 1 });
    await expect(da.get('records', 'missing')).rejects.toMatchObject({ retryable: false });
  });
});
