import { defaultUiPreferences } from '@crm/common';
import { UiPreferencesRepository } from './ui-preferences.repository';
import type { PrismaService } from '../prisma.service';

/**
 * The repository (feature 021, US1 — FR-001/FR-002/FR-003/FR-004).
 *
 * A fake table rather than a mocked client: the properties under test are about what ends up STORED
 * after a sequence of writes, and a `jest.fn()` returning a canned row would let a whole-record
 * replace pass as a partial write. The fake keys rows exactly as the schema does, so a query that
 * forgets `auth_user_id` or `account_id` returns the wrong rows here too.
 */

interface Row {
  account_id: string;
  auth_user_id: string;
  key: string;
  value: string;
}

function harness() {
  let rows: Row[] = [];
  /** Which account the scoped client was built for — proves `forAccount` is actually used. */
  const scopedFor: string[] = [];

  const table = (accountId: string) => ({
    findMany: async ({ where }: { where: { auth_user_id: string } }) =>
      rows
        .filter((r) => r.account_id === accountId && r.auth_user_id === where.auth_user_id)
        .map((r) => ({ key: r.key, value: r.value })),
    upsert: async (args: {
      where: {
        account_id_auth_user_id_key: { account_id: string; auth_user_id: string; key: string };
      };
      create: Row;
      update: { value: string };
    }) => {
      const id = args.where.account_id_auth_user_id_key;
      const found = rows.find(
        (r) =>
          r.account_id === id.account_id && r.auth_user_id === id.auth_user_id && r.key === id.key,
      );
      if (found) found.value = args.update.value;
      else rows.push({ ...args.create });
      return {};
    },
  });

  const prisma = {
    forAccount: (accountId: string) => {
      scopedFor.push(accountId);
      return { operatorUiPreference: table(accountId) };
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaService;

  return {
    repo: new UiPreferencesRepository(prisma),
    scopedFor,
    rowCount: () => rows.length,
    seed: (...seeded: Row[]) => {
      rows = [...rows, ...seeded];
    },
    all: () => rows,
  };
}

const ACC = 'acc-1';
const ME = 'user-1';

describe('*** reading: always complete, never a not-found, never a side effect ***', () => {
  it('a person with no stored rows gets every catalogue key at its default (FR-002)', async () => {
    const h = harness();
    await expect(h.repo.read(ACC, ME)).resolves.toEqual(defaultUiPreferences());
  });

  it('reading creates NOTHING — absence is answered from the catalogue, not materialised', async () => {
    // Materialising on first read would mean every page render writes, and it would make "has this
    // person ever chosen anything" unanswerable.
    const h = harness();
    await h.repo.read(ACC, ME);
    await h.repo.read(ACC, ME);
    expect(h.rowCount()).toBe(0);
  });

  it('a stored value overrides its default; the untouched key keeps its own', async () => {
    const h = harness();
    h.seed({ account_id: ACC, auth_user_id: ME, key: 'theme_mode', value: 'dark' });
    await expect(h.repo.read(ACC, ME)).resolves.toEqual({
      theme_mode: 'dark',
      font_size_step: 'default',
      unread_sound: 'on',
    });
  });

  it('goes through the account-scoped client on every read', async () => {
    const h = harness();
    await h.repo.read(ACC, ME);
    expect(h.scopedFor).toEqual([ACC]);
  });
});

describe('*** writing: partial, creating, and not clobbering ***', () => {
  it('the first write CREATES the record (FR-004)', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    expect(h.rowCount()).toBe(1);
    await expect(h.repo.read(ACC, ME)).resolves.toMatchObject({ theme_mode: 'dark' });
  });

  it('a write returns the COMPLETE resulting set, not just what changed (FR-001)', async () => {
    const h = harness();
    const out = await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    expect(Object.keys(out).sort()).toEqual(Object.keys(defaultUiPreferences()).sort());
  });

  it('changing ONE key leaves the other untouched — not reset to its default (FR-003)', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [
      ['theme_mode', 'dark'],
      ['font_size_step', 'large'],
    ]);
    await h.repo.apply(ACC, ME, [['font_size_step', 'compact']]);

    await expect(h.repo.read(ACC, ME)).resolves.toEqual({
      theme_mode: 'dark',
      font_size_step: 'compact',
      unread_sound: 'on',
    });
  });

  it('two callers changing DIFFERENT keys do not clobber each other', async () => {
    // The reason this is a row per key rather than one JSON column: with a blob, the second writer's
    // read-modify-write would silently undo the first. Here there is nothing to undo.
    const h = harness();
    await Promise.all([
      h.repo.apply(ACC, ME, [['theme_mode', 'dark']]),
      h.repo.apply(ACC, ME, [['font_size_step', 'large']]),
    ]);
    await expect(h.repo.read(ACC, ME)).resolves.toEqual({
      theme_mode: 'dark',
      font_size_step: 'large',
      unread_sound: 'on',
    });
  });

  it('re-writing a key UPDATES its row rather than adding a second', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    await h.repo.apply(ACC, ME, [['theme_mode', 'light']]);
    expect(h.rowCount()).toBe(1);
    await expect(h.repo.read(ACC, ME)).resolves.toMatchObject({ theme_mode: 'light' });
  });

  it('setting a key to its DEFAULT value stores it and is not an error', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'light']]);
    expect(h.rowCount()).toBe(1);
    await expect(h.repo.read(ACC, ME)).resolves.toMatchObject({ theme_mode: 'light' });
  });
});

describe('*** one person cannot reach another’s row (FR-013/FR-014) ***', () => {
  it('another PERSON in the same account has their own settings', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    await expect(h.repo.read(ACC, 'user-2')).resolves.toEqual(defaultUiPreferences());
  });

  it('the same person-identifier under ANOTHER account sees nothing of the first', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    await expect(h.repo.read('acc-2', ME)).resolves.toEqual(defaultUiPreferences());
  });

  it('a write under another account creates a SEPARATE row, never overwriting the first', async () => {
    const h = harness();
    await h.repo.apply(ACC, ME, [['theme_mode', 'dark']]);
    await h.repo.apply('acc-2', ME, [['theme_mode', 'light']]);
    expect(h.rowCount()).toBe(2);
    await expect(h.repo.read(ACC, ME)).resolves.toMatchObject({ theme_mode: 'dark' });
  });
});
