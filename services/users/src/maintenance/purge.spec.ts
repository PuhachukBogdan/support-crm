import { EPHEMERAL_PURPOSE_NAMES, UPLOAD_PURPOSE_NAMES, UPLOAD_PURPOSES } from '@crm/common';
import { InMemoryObjectStore } from '../uploads/object-store.fake';
import { ArtefactPurgeRepository } from '../uploads/artefact-purge.repository';
import { MaintenanceService, MAX_PURGE_BATCH } from './maintenance.service';
import type { PrismaService } from '../prisma.service';

/**
 * T042 (feature 017, US3) — **expiry is a DELETION** (FR-013/FR-014, research R8).
 *
 * This is the test for the one path in the product that removes stored bytes, and it is also the test
 * that feature 016's rule was NARROWED rather than weakened. 016 said "nothing in v1 removes bytes"; an
 * artefact whose defining property is that it expires cannot honour that, and a status flag saying
 * `expired` while the bytes sit in a bucket is SEC-27 rather than a fix for it.
 *
 * The narrowing is what the first two blocks below check: only `ephemeral` purposes are reachable, and
 * that set is derived from the catalogue rather than listed here. An avatar is not "excluded" — it is
 * unreachable, and would stay unreachable if someone added ten more purposes.
 *
 * ⚠️ Track A cannot prove the bytes are gone from a REAL bucket — the fake deletes from a `Map`. That is
 * Track B scenario E13, and it is why 4.10 may not be marked done on this file alone.
 */
const ARTEFACT = {
  id: 'up-1',
  storage_key: 'acc-1/conversation_export/aaaa',
  derivative_key: null,
};

function harness(
  rows: Array<{
    id: string;
    storage_key: string;
    derivative_key: string | null;
    purpose?: string;
    expires_at?: Date | null;
  }> = [ARTEFACT],
) {
  const store = new InMemoryObjectStore();
  for (const r of rows) {
    void store.put(r.storage_key, Uint8Array.from([1, 2, 3]), 'text/csv');
    if (r.derivative_key) void store.put(r.derivative_key, Uint8Array.from([4]), 'image/webp');
  }
  store.ops.length = 0; // the puts above are fixture setup, not behaviour under test

  const findManyCalls: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const upload = {
    findMany: jest.fn(async (args: Record<string, unknown>) => {
      findManyCalls.push(args);
      const where = args.where as { expires_at?: { lt?: Date } };
      const limit = (args.take as number) ?? rows.length;
      return rows
        .filter((r) => {
          const at = r.expires_at === undefined ? new Date(0) : r.expires_at;
          return at !== null && (!where.expires_at?.lt || at < where.expires_at.lt);
        })
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          storage_key: r.storage_key,
          derivative_key: r.derivative_key,
        }));
    }),
    delete: jest.fn(async (args: { where: { id: string } }) => {
      deleted.push(args.where.id);
      const at = rows.findIndex((r) => r.id === args.where.id);
      if (at >= 0) rows.splice(at, 1);
      return {};
    }),
  };
  const prisma = { upload } as unknown as PrismaService;
  const repo = new ArtefactPurgeRepository(prisma, store);
  return {
    service: new MaintenanceService(repo),
    repo,
    store,
    upload,
    deleted,
    findManyCalls,
    rows,
  };
}

const NOW = new Date('2026-07-30T12:00:00.000Z');

describe('*** only EPHEMERAL purposes are selectable, and the set is DERIVED ***', () => {
  it('exactly one purpose is ephemeral today, and it is the export artefact', () => {
    expect([...EPHEMERAL_PURPOSE_NAMES]).toEqual(['conversation_export']);
  });

  it('every non-ephemeral purpose is absent from the set — not excluded, absent', () => {
    for (const name of UPLOAD_PURPOSE_NAMES) {
      expect(EPHEMERAL_PURPOSE_NAMES.includes(name)).toBe(UPLOAD_PURPOSES[name].ephemeral);
    }
  });

  it('the purge predicate names the derived set and a past expiry — nothing else', async () => {
    const h = harness();
    await h.service.purgeExpiredArtefacts(10, NOW);

    const where = h.findManyCalls[0]!.where as {
      purpose: { in: string[] };
      expires_at: { not: null; lt: Date };
    };
    expect(where.purpose.in).toEqual([...EPHEMERAL_PURPOSE_NAMES]);
    expect(where.expires_at.lt).toBe(NOW);
    // A row with no expiry must be structurally unselectable, not merely sorted last.
    expect(where.expires_at.not).toBeNull();
  });

  it('the projection is ids and keys only — never a display name', async () => {
    const h = harness();
    await h.service.purgeExpiredArtefacts(10, NOW);
    const select = h.findManyCalls[0]!.select as Record<string, boolean>;
    // A filename is PII (SEC-26), and a sweep that never reads one cannot log one.
    expect(Object.keys(select).sort()).toEqual(['derivative_key', 'id', 'storage_key']);
  });
});

describe('*** the object goes BEFORE the row *** (the opposite of the create path, deliberately)', () => {
  it('bytes are deleted, then the row', async () => {
    const h = harness();
    const order: string[] = [];
    const origDelete = h.store.delete.bind(h.store);
    h.store.delete = (k) => {
      order.push('object');
      return origDelete(k);
    };
    h.upload.delete = jest.fn(async () => {
      order.push('row');
      return {};
    }) as never;

    await h.service.purgeExpiredArtefacts(10, NOW);
    // Row-first would orphan bytes that no future pass can find — permanently unreclaimable data,
    // which is exactly the leak FR-013 is about. Create goes the other way because ITS worst residue
    // is an object with no row.
    expect(order).toEqual(['object', 'row']);
  });

  it('a purged artefact leaves neither bytes nor row', async () => {
    const h = harness();
    expect(await h.service.purgeExpiredArtefacts(10, NOW)).toEqual({
      purged: 1,
      objectMissing: 0,
      failed: 0,
    });
    expect(h.store.keys()).toEqual([]);
    expect(h.deleted).toEqual(['up-1']);
  });

  it('a derivative is destroyed with its original', async () => {
    const h = harness([
      {
        id: 'up-2',
        storage_key: 'acc-1/conversation_export/bbbb',
        derivative_key: 'acc-1/conversation_export/bbbb.thumb.webp',
      },
    ]);
    await h.service.purgeExpiredArtefacts(10, NOW);
    // The one that is easy to forget: it is written by a second call and a cleanup that only knows
    // "the key" leaves it behind forever.
    expect(h.store.keys()).toEqual([]);
  });
});

describe('*** an already-absent object is NORMAL, not an error ***', () => {
  it('counted as object_missing, and the row is still removed', async () => {
    const h = harness();
    h.store.objects.clear(); // the bytes went in an earlier partial pass

    expect(await h.service.purgeExpiredArtefacts(10, NOW)).toEqual({
      purged: 0,
      objectMissing: 1,
      failed: 0,
    });
    // The row MUST go: leaving it would make the sweep report the same row forever, and the row is the
    // only thing keeping a reference to bytes that no longer exist.
    expect(h.deleted).toEqual(['up-1']);
  });

  it('no delete is issued for an object that is not there', async () => {
    const h = harness();
    h.store.objects.clear();
    await h.service.purgeExpiredArtefacts(10, NOW);
    expect(h.store.deletes()).toEqual([]);
  });
});

describe('*** a storage failure LEAVES THE ROW for the next tick ***', () => {
  it('counted as failed, row untouched', async () => {
    const h = harness();
    h.store.failNextDelete = new Error('bucket unreachable');

    expect(await h.service.purgeExpiredArtefacts(10, NOW)).toEqual({
      purged: 0,
      objectMissing: 0,
      failed: 1,
    });
    expect(h.deleted).toEqual([]);
  });

  it('a store that cannot be QUESTIONED also leaves the row', async () => {
    // `exists` throwing must not be read as "the object is gone". That misreading would delete the row
    // and lose the only reference to bytes that still exist.
    const h = harness();
    h.store.failNextExists = new Error('head refused');

    expect((await h.service.purgeExpiredArtefacts(10, NOW)).failed).toBe(1);
    expect(h.deleted).toEqual([]);
  });

  it('one artefact’s failure does not stop the pass', async () => {
    const h = harness([
      { id: 'up-1', storage_key: 'acc-1/conversation_export/aaaa', derivative_key: null },
      { id: 'up-2', storage_key: 'acc-1/conversation_export/bbbb', derivative_key: null },
    ]);
    h.store.failNextDelete = new Error('transient');

    const res = await h.service.purgeExpiredArtefacts(10, NOW);
    // They are independent, and the failed one is found again next tick. That is the whole of FR-014's
    // idempotence: a row that still exists IS the retry.
    expect(res).toEqual({ purged: 1, objectMissing: 0, failed: 1 });
  });

  it('the failure log names the storage key and nothing from a client', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    const h = harness();
    h.store.failNextDelete = new Error('bucket unreachable');
    await h.service.purgeExpiredArtefacts(10, NOW);
    spy.mockRestore();

    const all = lines.join('\n');
    expect(all).toContain('artefact.purge_storage_failed');
    // Without the key nobody can find what failed; with a filename it would be a PII leak in the one
    // place PII is hardest to redact later (the 016 precedent, verbatim).
    expect(all).toContain('acc-1/conversation_export/');
    expect(all).not.toMatch(/\.csv/);
  });
});

describe('*** idempotent: a re-run purges nothing twice *** (FR-014)', () => {
  it('the second pass finds nothing because the row is GONE', async () => {
    const h = harness();
    await h.service.purgeExpiredArtefacts(10, NOW);
    // No "purged" flag to reconcile, no retry counter, no window where a row is marked done but its
    // bytes are not. The row leaving the predicate IS the bookkeeping.
    expect(await h.service.purgeExpiredArtefacts(10, NOW)).toEqual({
      purged: 0,
      objectMissing: 0,
      failed: 0,
    });
  });

  it('an unexpired artefact is never selected', async () => {
    const h = harness([
      {
        id: 'up-9',
        storage_key: 'acc-1/conversation_export/cccc',
        derivative_key: null,
        expires_at: new Date('2026-07-31T00:00:00.000Z'),
      },
    ]);
    expect(await h.service.purgeExpiredArtefacts(10, NOW)).toEqual({
      purged: 0,
      objectMissing: 0,
      failed: 0,
    });
    expect(h.store.keys()).toHaveLength(1);
  });
});

describe('the batch is capped by the SERVER, whatever a caller asks', () => {
  it.each([
    [0, 100],
    [-5, 100],
    [Number.NaN, 100],
    [10, 10],
    [10_000, MAX_PURGE_BATCH],
  ])('limit %p becomes take %i', async (asked, expected) => {
    const h = harness();
    await h.service.purgeExpiredArtefacts(asked as number, NOW);
    expect(h.findManyCalls[0]!.take).toBe(expected);
  });
});
