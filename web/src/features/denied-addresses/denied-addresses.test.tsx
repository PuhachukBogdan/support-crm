import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { DeniedAddresses } from './denied-addresses';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';
import type { DeniedAddressWire } from './types';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.10) — the denied-addresses screen.
 *
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 * 1. **The warning comes BEFORE the write** (FR-034). Pressing «Ban this address» sends nothing; the
 *    consequence is stated, and only a second, deliberate act performs it. On this particular screen
 *    the administrator can lock themselves out, and afterwards there is no page left to warn them on.
 * 2. **An empty list means NOBODY IS DENIED, and the screen says so** — because the identical-looking
 *    list one screen over means the opposite when empty (FR-027). This is the one assertion here that
 *    is about words rather than behaviour, and it is the most valuable one on the file.
 * 3. **A repeat is a quiet SUCCESS** (`created: false`), said in the neutral register, never coloured
 *    as a refusal — otherwise an administrator goes off to fix a list that was already right.
 * 4. The four states are four different renderings (§4): loading ≠ empty ≠ error ≠ ready.
 * 5. Without `platform.settings.manage` the refusal is WORDS, and not one request is fired.
 *
 * Enforcement stays the server's (FR-024/FR-025) — these tests pin what the screen asks and says,
 * never who is allowed to ask it.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const ADDRESSES: DeniedAddressWire[] = [
  {
    id: 'd1',
    address: '203.0.113.10',
    note: 'scanning the login page since Tuesday',
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    createdBy: 'u-admin',
  },
  {
    id: 'd2',
    // The normalised form the boundary compares — not what somebody typed (FR-029).
    address: '2001:db8::1',
    note: '',
    createdAt: '2026-08-01T09:00:00.000Z',
    createdBy: 'u-nobody-we-know',
  },
];

interface Stub extends DataAccess {
  writes: { op: string; resource: ResourceName; id?: string; payload?: unknown }[];
  reads: ResourceName[];
}

function stub(
  opts: {
    addresses?: DeniedAddressWire[];
    failLists?: number;
    createAnswer?: unknown;
    removeAnswer?: unknown;
    failWith?: unknown;
  } = {},
): Stub {
  let listsLeftToFail = opts.failLists ?? 0;
  const s: Stub = {
    writes: [],
    reads: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      s.reads.push(resource);
      if (resource === 'admin-denied-addresses') {
        if (listsLeftToFail > 0) {
          listsLeftToFail -= 1;
          throw { message: 'boom', retryable: true };
        }
        return { items: (opts.addresses ?? ADDRESSES) as unknown as T[], nextCursor: null, hasMore: false };
      }
      // The name join (the audit-log precedent) — a different permission, and it degrades alone.
      if (resource === 'staff') {
        return {
          items: [{ userId: 'u-admin', email: 'admin@example.test' }] as unknown as T[],
          nextCursor: null,
          hasMore: false,
        };
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
      return (opts.createAnswer ?? { address: ADDRESSES[0], created: true }) as T;
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T> {
      s.writes.push({ op: 'update', resource, id, payload: patch });
      throw new Error('this screen has no update');
    },
    async remove<T = void>(resource: ResourceName, id: string): Promise<T> {
      s.writes.push({ op: 'remove', resource, id });
      if (opts.failWith) throw opts.failWith;
      return (opts.removeAnswer ?? { removed: true }) as T;
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
      <DeniedAddresses />
    </Providers>,
  );
}

afterEach(() => setDataAccess(new MockDataAccess()));

describe('the four states are four different renderings', () => {
  it('loading → ready: the address, its note, and who added it when', async () => {
    const s = renderScreen(stub());

    // Loading first: a skeleton shaped like the rows, never a blank or a premature «empty».
    expect(screen.queryByTestId('denied-list')).toBeNull();
    expect(s.container.querySelector('[aria-busy]')).not.toBeNull();

    const list = await screen.findByTestId('denied-list');
    expect(list).toHaveTextContent('203.0.113.10');

    const first = screen.getByTestId('denied-d1');
    expect(first).toHaveTextContent('scanning the login page since Tuesday');
    expect(first).toHaveTextContent('3 minutes ago');
    // The id is joined to a name the product already knows; the join is a courtesy, not a source.
    await waitFor(() => expect(screen.getByTestId('denied-d1')).toHaveTextContent('admin@example.test'));
    // Monospace, because an address is compared character by character.
    expect(first.querySelector('code')?.className).toContain('font-mono');

    const second = screen.getByTestId('denied-d2');
    expect(second).toHaveTextContent('2001:db8::1');
    expect(second).toHaveTextContent('no note');
    // An id with no match renders as itself rather than as a blank or an invented name.
    expect(second).toHaveTextContent('u-nobody-we-know');
  });

  it('⭐⭐ empty says NOBODY IS DENIED — and warns that the neighbouring screen means the opposite', async () => {
    renderScreen(stub({ addresses: [] }));
    const empty = await screen.findByTestId('denied-empty');

    // The meaning, not the count.
    expect(empty).toHaveTextContent(/nobody is denied/i);
    expect(empty).toHaveTextContent(/refuses nobody/i);
    // ⚠️ The habit this prevents: on `/admin/api-keys` an empty address list means nobody is ALLOWED.
    expect(empty).toHaveTextContent(/nobody is allowed/i);
    // An invitation to act, and a real control (never a button that does nothing).
    expect(screen.getByTestId('denied-empty-new')).toBeInTheDocument();
    // Empty and broken must never look the same (§4).
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('…and the same warning is on the header, where a non-empty list can also be misread', async () => {
    renderScreen(stub());
    await screen.findByTestId('denied-list');
    expect(document.body.textContent).toContain('An empty list here denies nobody');
    expect(document.body.textContent).toMatch(/empty list permits nobody/i);
  });

  it('error renders the retry path, and retry re-reads into the ready list', async () => {
    renderScreen(stub({ failLists: 1 }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('denied-empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('denied-list')).toHaveTextContent('203.0.113.10');
  });
});

describe('⭐⭐ the warning comes before the write, and the write needs a second act', () => {
  it('pressing «Ban this address» sends NOTHING and states the consequence', async () => {
    const s = stub({ addresses: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));

    fireEvent.change(screen.getByTestId('denied-address'), { target: { value: ' 203.0.113.10 ' } });
    fireEvent.click(screen.getByTestId('denied-save'));

    // The act has not happened — this is the whole point of the ordering (FR-034).
    expect(s.writes).toHaveLength(0);

    // …and the warning is honest about what the product does NOT know.
    const warning = await screen.findByText(/cannot tell you whether that is the address you are connected from/i);
    expect(warning).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/lose access on your very next request/i);
    expect(document.body.textContent).toMatch(/connects from a different address/i);
    // The address as it will be sent, in the question itself.
    expect(document.body.textContent).toMatch(/Refuse every request from 203\.0\.113\.10\?/);
  });

  it('confirming sends the trimmed body, re-reads the list, and closes the editor', async () => {
    const s = stub({ addresses: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));
    fireEvent.change(screen.getByTestId('denied-address'), { target: { value: ' 203.0.113.10 ' } });
    fireEvent.change(screen.getByTestId('denied-note'), { target: { value: '  scanning  ' } });
    fireEvent.click(screen.getByTestId('denied-save'));
    fireEvent.click(await screen.findByTestId('denied-confirm'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'admin-denied-addresses',
          payload: { address: '203.0.113.10', note: 'scanning' },
        }),
      ),
    );

    // The re-read (the W28 rule): nothing is merged locally — and here it also means the list shows
    // the NORMALISED address the server stored rather than the string that was typed.
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-denied-addresses').length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByTestId('denied-form')).toBeNull());
  });

  it('backing out of the warning writes nothing and keeps the typed address', async () => {
    const s = stub({ addresses: [] });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));
    fireEvent.change(screen.getByTestId('denied-address'), { target: { value: '203.0.113.10' } });
    fireEvent.click(screen.getByTestId('denied-save'));
    fireEvent.click(await screen.findByTestId('denied-cancel'));

    expect(s.writes).toHaveLength(0);
    expect(screen.getByTestId('denied-address')).toHaveValue('203.0.113.10');
  });

  it('Escape closes the editor without a write (keyboard floor, §4)', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));
    fireEvent.keyDown(screen.getByTestId('denied-form'), { key: 'Escape' });
    expect(screen.queryByTestId('denied-form')).toBeNull();
    expect(s.writes).toHaveLength(0);
  });
});

describe('⭐ the two «nothing changed» answers are successes, in words', () => {
  it('adding an address that is already listed is a QUIET SUCCESS, not an error', async () => {
    const s = stub({
      addresses: [],
      // ⚠️ The server's own answer to a repeat: the existing row, and `created: false`.
      createAnswer: { address: { ...ADDRESSES[0], address: '203.0.113.10' }, created: false },
    });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));
    fireEvent.change(screen.getByTestId('denied-address'), { target: { value: '203.0.113.10' } });
    fireEvent.click(screen.getByTestId('denied-save'));
    fireEvent.click(await screen.findByTestId('denied-confirm'));

    const notice = await screen.findByTestId('denied-notice');
    expect(notice).toHaveTextContent(/already on the list/i);
    expect(notice).toHaveTextContent(/same intent expressed twice/i);
    // ⛔ Not an error, in any register: no error line, and the editor closes like any success.
    expect(screen.queryByTestId('denied-mutation-error')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('denied-form')).toBeNull());
  });

  it('removing an address that is already gone is the same shape', async () => {
    const s = stub({ removeAnswer: { removed: false } });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-remove-d1'));
    fireEvent.click(await screen.findByTestId('denied-remove-confirm'));

    const notice = await screen.findByTestId('denied-notice');
    expect(notice).toHaveTextContent(/already off the list/i);
    expect(screen.queryByTestId('denied-mutation-error')).toBeNull();
  });

  it('lifting a ban asks first, then DELETEs and re-reads', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-remove-d1'));

    // Opening the question is not the act.
    expect(s.writes).toHaveLength(0);
    expect(await screen.findByText(/reaches the product exactly like any other/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('denied-remove-confirm'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ op: 'remove', resource: 'admin-denied-addresses', id: 'd1' }),
      ),
    );
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-denied-addresses').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('⚠️ a malformed address is refused in words that name the shape, not «request not valid»', async () => {
    // The one 400 this route produces is `invalid_address`; the transport never reads a body, so the
    // screen reads the failure CLASS and says the only thing that class can mean here.
    const s = stub({
      addresses: [],
      failWith: { message: 'The request was not valid.', retryable: false, code: 'invalid-request' },
    });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('denied-new'));
    fireEvent.change(screen.getByTestId('denied-address'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByTestId('denied-save'));
    fireEvent.click(await screen.findByTestId('denied-confirm'));

    const error = await screen.findByTestId('denied-mutation-error');
    expect(error).toHaveTextContent(/nothing was saved/i);
    expect(error).toHaveTextContent(/single IP address/i);
    // A refusal never eats their work, and never claims a success.
    expect(screen.getByTestId('denied-form')).toBeInTheDocument();
    expect(screen.queryByTestId('denied-notice')).toBeNull();
  });
});

describe('⛔ the section is an administrator surface', () => {
  it('without platform.settings.manage: the refusal in words, and NOT ONE request is fired', async () => {
    const s = stub();
    renderScreen(s, ['crm.inbox.view', 'crm.conversation.reply']);
    const denied = await screen.findByTestId('denied-denied');
    expect(denied).toHaveTextContent('platform.settings.manage');
    expect(denied).toHaveTextContent('administrator');
    // The courtesy gate short-circuits the whole screen — reads AND writes (the W28 rule).
    expect(s.reads).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
    expect(screen.queryByTestId('denied-new')).toBeNull();
    expect(screen.queryByTestId('denied-list')).toBeNull();
  });
});
