import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { MacrosAdmin } from './macros-admin';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

/**
 * ⭐⭐ W29 (R46) — one screen, three tabs. What these tests pin: the working half authors and
 * deletes through the real resources; the refusal for non-authors is WORDS; and the two stubs are
 * sentences with NOT ONE control — a placeholder that looks like a broken form is the defect.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const MACROS = [
  {
    id: 'm1',
    name: 'Refund approved',
    actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }],
    text: 'Ваш возврат оформлен.',
    groupIds: ['g1'],
    appliedLast7: 12,
  },
  { id: 'm2', name: 'Classify deposit', actions: [{ type: 'MACRO_ACTION_TYPE_SET_CATEGORY', value: 'payments' }], text: '', groupIds: [], appliedLast7: 0 },
];

interface Stub extends DataAccess {
  writes: { op: string; resource: ResourceName; id?: string; payload?: unknown }[];
}

function stub(opts: { failWith?: unknown; groupsFail?: boolean } = {}): Stub {
  const s: Stub = {
    writes: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'macros') return { items: MACROS as unknown as T[], nextCursor: null, hasMore: false };
      if (resource === 'groups') {
        if (opts.groupsFail) throw { message: 'forbidden', retryable: false };
        return { items: [{ id: 'g1', name: 'VIP desk', active: true, memberCount: 2 }] as unknown as T[], nextCursor: null, hasMore: false };
      }
      if (resource === 'conversation-statuses') {
        return { items: [{ key: 'pending', agentName: 'Pending', active: true }] as unknown as T[], nextCursor: null, hasMore: false };
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('no gets here');
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      s.writes.push({ op: 'create', resource, payload: input });
      if (opts.failWith) throw opts.failWith;
      return {} as T;
    },
    async update<T = unknown>(): Promise<T> {
      throw new Error('no updates here');
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

function renderScreen(s: Stub, keys: string[] = ['crm.macros.use', 'crm.templates.manage']) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={seed(keys) as never}>
      <MacrosAdmin />
    </Providers>,
  );
}

afterEach(() => setDataAccess(new MockDataAccess()));

/** Radix Tabs activate on POINTER-DOWN (the W28 lesson — a bare click is not a pointer sequence). */
function switchTab(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

describe('the working tab: list, usage counter, create, delete', () => {
  it('lists macros with the weekly counter, the scope badge and the text preview', async () => {
    renderScreen(stub());
    const list = await screen.findByTestId('macros-list');
    expect(list).toHaveTextContent('Refund approved');
    expect(screen.getByTestId('macro-usage-m1')).toHaveTextContent('12× / 7d');
    expect(screen.getByTestId('macro-scoped-m1')).toHaveTextContent('1 group');
    expect(list).toHaveTextContent('Ваш возврат оформлен.');
  });

  it('⭐ creates through the real resource: name + text + actions + groups', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('macro-new'));

    fireEvent.change(screen.getByTestId('macro-name'), { target: { value: 'Welcome' } });
    fireEvent.change(screen.getByTestId('macro-text'), { target: { value: 'Здравствуйте!' } });
    fireEvent.keyDown(screen.getByTestId('macro-add-action'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('add-set_status'));
    fireEvent.change(screen.getByTestId('action-value-0'), { target: { value: 'pending' } });
    fireEvent.click(screen.getByLabelText('Available to VIP desk'));
    fireEvent.click(screen.getByTestId('macro-save'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'macros',
          payload: {
            name: 'Welcome',
            text: 'Здравствуйте!',
            groupIds: ['g1'],
            actions: [{ type: 'set_status', value: 'pending' }],
          },
        }),
      ),
    );
  });

  it('deletes through the real resource, and a refusal is said beside the list', async () => {
    const s = stub({ failWith: { message: 'forbidden', retryable: false } });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('macro-delete-m1'));
    await waitFor(() => expect(s.writes).toContainEqual(expect.objectContaining({ op: 'remove', id: 'm1' })));
    expect(await screen.findByTestId('macros-error')).toHaveTextContent('forbidden');
    expect(screen.getByTestId('macros-list')).toBeInTheDocument();
  });

  it('⭐ without templates.manage the tab is a REFUSAL IN WORDS — not an empty screen, not a dead form', async () => {
    const s = stub();
    renderScreen(s, ['crm.macros.use']);
    const denied = await screen.findByTestId('authoring-denied');
    expect(denied).toHaveTextContent('supervisor');
    expect(denied).toHaveTextContent('crm.templates.manage');
    expect(screen.queryByTestId('macro-new')).toBeNull();
  });

  it('the group picker degrades ALONE: a teamlead without the groups read authors unscoped macros', async () => {
    renderScreen(stub({ groupsFail: true }));
    fireEvent.click(await screen.findByTestId('macro-new'));
    expect(screen.getByTestId('macro-form')).toBeInTheDocument();
    expect(screen.queryByTestId('macro-groups')).toBeNull(); // absent, not broken
  });
});

describe('⛔ the two stubs are sentences, not controls', () => {
  it.each([
    ['tab-automations', 'automations-stub'],
    ['tab-triggers', 'triggers-stub'],
  ])('%s → %s: Coming Soon, and NOT ONE interactive control inside', async (tabId, stubId) => {
    renderScreen(stub());
    await screen.findByTestId('macros-list');
    switchTab(tabId);

    const panel = await screen.findByTestId(stubId);
    // The badge's own word is `soon` (coming-soon.tsx renders the icon + «soon»).
    expect(panel).toHaveTextContent(/soon/i);
    // The claim that keeps a placeholder honest: no buttons, no inputs, no selects, no switches.
    expect(panel.querySelectorAll('button, input, select, textarea, [role="switch"]')).toHaveLength(0);
  });
});
