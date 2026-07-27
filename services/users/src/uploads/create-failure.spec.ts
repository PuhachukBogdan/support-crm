import type { PrismaService } from '../prisma.service';
import { UploadsRepository } from './uploads.repository';
import { InMemoryObjectStore } from './object-store.fake';
import type { ValidatedUpload } from './validate';
import { UPLOAD_PURPOSES } from '@crm/common';

/**
 * T060 (feature 016) — **bytes never end up stored with no record accounting for them** (FR-009 /
 * SC-011).
 *
 * The residue this guards against is specific and nasty: an object in the bucket with no row. It is
 * invisible to the product (nothing knows its id), unreclaimable by any future retention job (which
 * looks at rows), and it costs money forever. The ordering makes it the ONLY reachable residue —
 * validation and derivative production happen first, the put is the last thing before the row — so
 * this test is about what happens in exactly that window.
 *
 * ── Why the fake is lazy ─────────────────────────────────────────────────────────────────────────
 * The store fake records operations in order and its failures are one-shot. That matters: the
 * assertion is not "the object is absent afterwards" but "a delete was ISSUED for it" — a claim
 * about what the code did, which survives a future change to how the fake keeps state.
 */
const ACCOUNT = 'acc-1';
const USER = 'op-1';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validated(withDerivative: boolean): ValidatedUpload {
  return {
    purposeName: 'message_attachment',
    purpose: UPLOAD_PURPOSES.message_attachment,
    contentType: 'image/png',
    bytes: PNG,
    displayName: 'john_smith_passport.png', // deliberately PII-shaped — see the log assertions
    derivative: withDerivative
      ? { body: Uint8Array.from([1, 2]), contentType: 'image/webp', byteSize: 2 }
      : null,
  };
}

function harness(createImpl: () => Promise<unknown>) {
  const store = new InMemoryObjectStore();
  const create = jest.fn(createImpl);
  const forAccount = jest.fn(() => ({ upload: { create } }));
  const prisma = { forAccount } as unknown as PrismaService;
  return { repo: new UploadsRepository(prisma, store), store, create };
}

const ok = () =>
  Promise.resolve({
    id: 'up-1',
    account_id: ACCOUNT,
    purpose: 'message_attachment',
    uploader_user_id: USER,
    content_type: 'image/png',
    byte_size: PNG.byteLength,
    checksum_sha256: 'x',
    storage_key: 'k',
    display_name: 'shot.png',
    derivative_key: null,
    derivative_byte_size: null,
    state: 'pending',
    claimed_at: null,
    created_at: new Date(),
  });

describe('the happy path stores then records — in that order', () => {
  it('the object is put BEFORE the row is written', async () => {
    const order: string[] = [];
    const store = new InMemoryObjectStore();
    const origPut = store.put.bind(store);
    store.put = (k, b, t) => {
      order.push('put');
      return origPut(k, b, t);
    };
    const create = jest.fn(() => {
      order.push('row');
      return ok();
    });
    const prisma = { forAccount: jest.fn(() => ({ upload: { create } })) } as unknown as PrismaService;

    await new UploadsRepository(prisma, store).create(ACCOUNT, USER, validated(false));
    // Row-first would fail toward a RECORDED upload whose bytes are not there — worse, because a
    // consumer will reference it and every read fails forever.
    expect(order).toEqual(['put', 'row']);
  });

  it('a derivative is stored under its own key, alongside the original', async () => {
    const { repo, store } = harness(ok);
    await repo.create(ACCOUNT, USER, validated(true));
    const [original, derivative] = store.puts();
    expect(original).toMatch(new RegExp(`^${ACCOUNT}/message_attachment/[0-9a-f-]{36}$`));
    expect(derivative).toBe(`${original}.thumb.webp`);
  });

  it('the storage key is system-generated and owes nothing to the filename', async () => {
    const { repo, store } = harness(ok);
    await repo.create(ACCOUNT, USER, validated(false));
    // FR-008: a client-supplied name never decides where bytes live.
    expect(store.puts()[0]).not.toContain('john_smith');
    expect(store.puts()[0]).not.toContain('.png');
  });

  it('the checksum is of the ACCEPTED bytes', async () => {
    const { repo, create } = harness(ok);
    await repo.create(ACCOUNT, USER, validated(false));
    const { data } = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    // sha256 of the 8-byte PNG signature, pinned literally so a change of input, of the hash, or of
    // WHICH bytes are hashed (original vs derivative) is visible rather than merely still-a-hash.
    expect(data.checksum_sha256).toBe(
      '4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6',
    );
    // It is NOT NULL by schema — a nullable checksum nobody fills is dead weight.
    expect(data.byte_size).toBe(PNG.byteLength);
  });
});

describe('*** a failed row write leaves NO orphaned object *** (SC-011)', () => {
  it('the object is deleted and the error is rethrown', async () => {
    const boom = new Error('unique constraint violated');
    const { repo, store } = harness(() => Promise.reject(boom));

    await expect(repo.create(ACCOUNT, USER, validated(false))).rejects.toBe(boom);

    const put = store.puts();
    expect(put).toHaveLength(1);
    // A delete was ISSUED for exactly what was put — the assertion is about the action, not the
    // leftover state.
    expect(store.deletes()).toEqual(put);
    expect(store.keys()).toEqual([]);
  });

  it('BOTH objects are deleted when a derivative was stored', async () => {
    const { repo, store } = harness(() => Promise.reject(new Error('write failed')));
    await expect(repo.create(ACCOUNT, USER, validated(true))).rejects.toThrow();
    // The derivative is the one it would be easy to forget: it is produced earlier and written in a
    // second call, so a cleanup that only knows about "the key" leaves it behind forever.
    expect(store.deletes().sort()).toEqual(store.puts().sort());
    expect(store.keys()).toEqual([]);
  });

  it('the failure is reported, not swallowed', async () => {
    const { repo } = harness(() => Promise.reject(new Error('write failed')));
    // A swallowed failure would return no row to a caller that believes the upload succeeded.
    await expect(repo.create(ACCOUNT, USER, validated(false))).rejects.toThrow('write failed');
  });
});

describe('*** the discrepancy is logged, and the log carries no filename *** (SC-007 / FR-020)', () => {
  const lines: string[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    lines.length = 0;
    spy = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  });
  afterEach(() => spy.mockRestore());

  it('a failed row write logs the storage keys and nothing from the client', async () => {
    const { repo } = harness(() => Promise.reject(new Error('write failed')));
    await expect(repo.create(ACCOUNT, USER, validated(true))).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('upload.record_write_failed');
    // The keys are needed — without them nobody can find what to clean up.
    expect(all).toContain(`${ACCOUNT}/message_attachment/`);
    // The filename is not, and it is PII-shaped on purpose in this fixture.
    expect(all).not.toContain('john_smith_passport');
    expect(all).not.toContain('passport');
  });

  it('a failure to DELETE is logged too, and does not mask the real error', async () => {
    const store = new InMemoryObjectStore();
    store.failNextDelete = new Error('bucket unreachable');
    const create = jest.fn(() => Promise.reject(new Error('row write failed')));
    const prisma = { forAccount: jest.fn(() => ({ upload: { create } })) } as unknown as PrismaService;

    // The rethrown error must still be the ROW failure: reporting the cleanup problem instead would
    // point at the wrong cause entirely.
    await expect(
      new UploadsRepository(prisma, store).create(ACCOUNT, USER, validated(false)),
    ).rejects.toThrow('row write failed');
    expect(lines.join('\n')).toContain('upload.orphan_object_not_removed');
  });

  it('no log line on the failure path contains file bytes', async () => {
    const { repo } = harness(() => Promise.reject(new Error('write failed')));
    await expect(repo.create(ACCOUNT, USER, validated(true))).rejects.toThrow();
    const all = lines.join('\n');
    expect(all).not.toContain(Buffer.from(PNG).toString('base64'));
    expect(all).not.toMatch(/\bcontent\b\s*:/);
  });
});
