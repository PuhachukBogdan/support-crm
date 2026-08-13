import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { ApiKeys } from './api-keys';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';
import type { ApiKeyWire } from './types';

/**
 * ⭐ W31 (спек №2 / feature 038, roadmap 3.17) — the API-keys screen.
 *
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 * 1. **The value is shown exactly once and then is GONE** (FR-001, US1 scenarios 1–2). Not hidden
 *    behind a toggle, not re-fetchable, not present in the DOM after the panel is dismissed, and
 *    not restored by re-opening the screen. This is the whole security property of the screen, and
 *    it is the one thing a passing suite could have missed while every request was correct.
 * 2. Rotation and revocation ASK first and then send the right call — the old value dies the moment
 *    the new one appears, so an accidental click is an outage for whoever holds the key.
 * 3. The four states are four different renderings (§4): loading ≠ empty ≠ error ≠ ready.
 * 4. Without `platform.settings.manage` the refusal is WORDS and not one request is fired.
 *
 * Enforcement stays the server's (FR-004) — these tests pin the questions the screen asks, never
 * who is allowed to ask them.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const KEYS: ApiKeyWire[] = [
  {
    id: 'k1',
    consumer: 'HR platform',
    fingerprint: 'k1:9f2a…c7',
    ipAllowList: ['203.0.113.10'],
    ratePerHour: 60,
    active: true,
    lastUsedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    createdAt: '2026-08-01T09:00:00.000Z',
    rotatedFromId: '',
  },
  {
    id: 'k2',
    consumer: 'Retired importer',
    fingerprint: 'k2:11bb…04',
    // ⚠️ The fail-closed row: an empty allow-list is «nobody», and the screen must say so.
    ipAllowList: [],
    ratePerHour: 10,
    active: false,
    lastUsedAt: '',
    createdAt: '2026-07-01T09:00:00.000Z',
    rotatedFromId: 'k0',
  },
];

/** The one shape in the product that carries a value — a WRITE's answer, never a read's. */
const VALUE = 'k9.s3cr3t-value-shown-once';
const ISSUED = {
  key: { ...KEYS[0], id: 'k9', consumer: 'HR platform', fingerprint: 'k9:aa11…ff' },
  value: VALUE,
};

interface Stub extends DataAccess {
  writes: { op: string; resource: ResourceName; id?: string; within?: string; payload?: unknown }[];
  reads: ResourceName[];
}

function stub(opts: { keys?: ApiKeyWire[]; failWith?: unknown; failLists?: number } = {}): Stub {
  let listsLeftToFail = opts.failLists ?? 0;
  const s: Stub = {
    writes: [],
    reads: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      s.reads.push(resource);
      if (resource === 'admin-api-keys') {
        if (listsLeftToFail > 0) {
          listsLeftToFail -= 1;
          throw { message: 'boom', retryable: true };
        }
        return { items: (opts.keys ?? KEYS) as unknown as T[], nextCursor: null, hasMore: false };
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(resource: ResourceName): Promise<T> {
      s.reads.push(resource);
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      s.writes.push({ op: 'create', resource, payload: input });
      if (opts.failWith) throw opts.failWith;
      return ISSUED as unknown as T;
    },
    async update<T = unknown>(
      resource: ResourceName,
      id: string,
      patch: unknown,
      within?: string,
    ): Promise<T> {
      s.writes.push({ op: 'update', resource, id, within, payload: patch });
      if (opts.failWith) throw opts.failWith;
      return ISSUED as unknown as T;
    },
    async remove<T = void>(resource: ResourceName, id: string): Promise<T> {
      s.writes.push({ op: 'remove', resource, id });
      if (opts.failWith) throw opts.failWith;
      return undefined as T;
    },
    subscribe(): () => void {
      return () => {};
    },
  };
  return s;
}

const seed = (keys: string[]) =>
  ({ kind: 'authenticated', userId: 'u1', accountId: 'a1', roles: [], permissionKeys: keys }) as const;

function renderScreen(s: Stub, keys: string[] = ['platform.settings.manage']) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={seed(keys) as never}>
      <ApiKeys />
    </Providers>,
  );
}

afterEach(() => setDataAccess(new MockDataAccess()));

describe('the four states are four different renderings', () => {
  it('loading → ready: consumer, fingerprint, state, addresses, rate and last use', async () => {
    const s = renderScreen(stub());

    // Loading first: a skeleton shaped like the rows, never a blank or a premature «empty».
    expect(screen.queryByTestId('keys-list')).toBeNull();
    expect(s.container.querySelector('[aria-busy]')).not.toBeNull();

    const list = await screen.findByTestId('keys-list');
    expect(list).toHaveTextContent('HR platform');

    const active = screen.getByTestId('key-k1');
    expect(active).toHaveTextContent('k1:9f2a…c7');
    expect(active).toHaveTextContent('active');
    expect(active).toHaveTextContent('203.0.113.10');
    expect(active).toHaveTextContent('60 calls per hour');
    expect(active).toHaveTextContent('last used 3 minutes ago');

    const revoked = screen.getByTestId('key-k2');
    expect(revoked).toHaveTextContent('revoked');
    expect(revoked).toHaveTextContent('never used');
    // ⚠️ Fail-closed, said rather than left to be discovered (FR-002).
    expect(revoked).toHaveTextContent('every call with this key is refused');
    // Nothing left to do TO a revoked key — the row stays for the journal.
    expect(screen.queryByTestId('key-rotate-k2')).toBeNull();
    expect(screen.queryByTestId('key-revoke-k2')).toBeNull();
  });

  it('empty is an INVITATION with the create action present — never «No data»', async () => {
    renderScreen(stub({ keys: [] }));
    const empty = await screen.findByTestId('keys-empty');
    expect(empty).toHaveTextContent(/No keys yet/);
    expect(screen.getByTestId('key-new')).toBeInTheDocument();
    // Empty and broken must never look the same (§4).
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('error renders the retry path, and retry re-reads into the ready list', async () => {
    renderScreen(stub({ failLists: 1 }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('keys-empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('keys-list')).toHaveTextContent('HR platform');
  });
});

describe('⭐ the value is shown ONCE, and then the product genuinely does not have it', () => {
  it('issuing sends the whole body, re-reads the list, and shows the value once', async () => {
    const s = stub({ keys: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));

    fireEvent.change(screen.getByTestId('key-consumer'), { target: { value: '  HR platform  ' } });
    fireEvent.change(screen.getByTestId('key-ips'), {
      target: { value: '203.0.113.10, 198.51.100.7' },
    });
    fireEvent.change(screen.getByTestId('key-rate'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('key-save'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'admin-api-keys',
          payload: {
            consumer: 'HR platform',
            ipAllowList: ['203.0.113.10', '198.51.100.7'],
            ratePerHour: 120,
          },
        }),
      ),
    );

    // The panel, with the value and the sentence that makes it honest.
    const panel = await screen.findByTestId('key-value-panel');
    expect(screen.getByTestId('key-value')).toHaveTextContent(VALUE);
    expect(panel).toHaveTextContent(/will not show it again/i);
    expect(panel).toHaveTextContent(/rotated/i);

    // The re-read (the W28 rule): nothing is merged locally, the server's word is fetched again.
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-api-keys').length).toBeGreaterThanOrEqual(2),
    );
    // Success closes the editor.
    await waitFor(() => expect(screen.queryByTestId('key-form')).toBeNull());
  });

  it('⭐ dismissing the panel removes the value from the DOM entirely', async () => {
    const s = stub({ keys: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));
    fireEvent.change(screen.getByTestId('key-consumer'), { target: { value: 'HR platform' } });
    fireEvent.click(screen.getByTestId('key-save'));

    await screen.findByTestId('key-value-panel');
    fireEvent.click(screen.getByTestId('key-value-dismiss'));

    expect(screen.queryByTestId('key-value-panel')).toBeNull();
    expect(screen.queryByTestId('key-value')).toBeNull();
    // Not merely unmounted — the string is nowhere on the page.
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it('⭐ re-opening the screen does not bring the value back — no read ever carries one', async () => {
    const s = stub({ keys: [] });
    const { unmount } = renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));
    fireEvent.change(screen.getByTestId('key-consumer'), { target: { value: 'HR platform' } });
    fireEvent.click(screen.getByTestId('key-save'));
    await screen.findByTestId('key-value-panel');
    fireEvent.click(screen.getByTestId('key-value-dismiss'));

    // The administrator closes the section and comes back (US1 scenario 2).
    unmount();
    renderScreen(s);
    await screen.findByTestId('keys-empty');

    expect(screen.queryByTestId('key-value-panel')).toBeNull();
    expect(document.body.textContent).not.toContain(VALUE);
    // …and the reason: the LIST is the only thing a re-open reads, and it answers with no value.
    expect(s.reads.every((r) => r === 'admin-api-keys')).toBe(true);
    expect(JSON.stringify(KEYS)).not.toContain('value');
  });

  it('Escape closes the value panel too, and it does not come back', async () => {
    const s = stub({ keys: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));
    fireEvent.change(screen.getByTestId('key-consumer'), { target: { value: 'HR platform' } });
    fireEvent.click(screen.getByTestId('key-save'));
    await screen.findByTestId('key-value-panel');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('key-value-panel')).toBeNull());
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it('a refused issuance is said IN WORDS and no panel claims a value exists', async () => {
    const s = stub({ keys: [], failWith: { message: 'a key for this consumer already exists', retryable: false } });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));
    fireEvent.change(screen.getByTestId('key-consumer'), { target: { value: 'HR platform' } });
    fireEvent.click(screen.getByTestId('key-save'));

    expect(await screen.findByTestId('keys-mutation-error')).toHaveTextContent(
      'a key for this consumer already exists',
    );
    expect(screen.queryByTestId('key-value-panel')).toBeNull();
    // The editor stays open with the admin's input — a refusal never eats their work.
    expect(screen.getByTestId('key-form')).toBeInTheDocument();
  });

  it('Escape closes the create form without a write (keyboard floor, §4)', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-new'));
    fireEvent.keyDown(screen.getByTestId('key-form'), { key: 'Escape' });
    expect(screen.queryByTestId('key-form')).toBeNull();
    expect(s.writes).toHaveLength(0);
  });
});

describe('rotation and revocation ask first, then send the act', () => {
  it('⭐ rotation: the trigger alone writes nothing; the confirmation POSTs to the child path', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-rotate-k1'));

    // Opening the dialog is not the act — the old value is still alive at this point.
    expect(s.writes).toHaveLength(0);
    expect(await screen.findByText(/stops working immediately/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('key-rotate-confirm'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'update',
          resource: 'admin-api-key-rotate',
          // A singleton child: no id of its own, the KEY is the parent instance.
          id: '',
          within: 'k1',
        }),
      ),
    );
    // Rotation mints, so it shows the new value once — same panel, same one-shot rule.
    expect(await screen.findByTestId('key-value')).toHaveTextContent(VALUE);
  });

  it('⭐ revocation: the confirmation names the consequence, then DELETEs the key', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('key-revoke-k1'));

    expect(s.writes).toHaveLength(0);
    // The description predicts the consequence and states what is NOT destroyed.
    expect(await screen.findByText(/very next call with it is refused/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is erased/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('key-revoke-confirm'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ op: 'remove', resource: 'admin-api-keys', id: 'k1' }),
      ),
    );
    // A revocation never shows a value — there is nothing to show.
    expect(screen.queryByTestId('key-value-panel')).toBeNull();
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-api-keys').length).toBeGreaterThanOrEqual(2),
    );
  });
});

describe('⛔ the section is an administrator surface', () => {
  it('without platform.settings.manage: the refusal in words, and NOT ONE request is fired', async () => {
    const s = stub();
    renderScreen(s, ['crm.inbox.view', 'crm.conversation.reply']);
    const denied = await screen.findByTestId('keys-denied');
    expect(denied).toHaveTextContent('platform.settings.manage');
    expect(denied).toHaveTextContent('administrator');
    // The courtesy gate short-circuits the whole screen — reads AND writes (the W28 rule).
    expect(s.reads).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
    expect(screen.queryByTestId('key-new')).toBeNull();
    expect(screen.queryByTestId('keys-list')).toBeNull();
  });
});
