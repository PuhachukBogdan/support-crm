import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { TicketFields } from './ticket-fields';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';
import type { FieldConfigWire } from './types';

/**
 * ⭐ W30 (спек №1, roadmap 4.15) — the authoring screen. What these tests pin: one read projection
 * feeds three tabs; every write goes through the real resources and ends in a RE-READ (never a
 * local merge); the refusal for non-holders is WORDS and fires not one request; and the archive is
 * a PATCH with `active: false`, never a delete. Enforcement stays the server's — these tests pin
 * the questions the screen asks, not who may ask them.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const CONFIG: FieldConfigWire = {
  optionSets: [
    {
      id: 'os1',
      name: 'Deposit status',
      values: [
        { value: 'Declined', order: 0, active: true },
        { value: 'Approved', order: 1, active: true },
        { value: 'Old value', order: 2, active: false },
      ],
    },
  ],
  fields: [
    {
      id: 'f1',
      key: 'deposit_status',
      label: 'Deposit status',
      type: 'dropdown',
      required: true,
      restricted: false,
      optionSetId: 'os1',
      brandIds: [],
      active: true,
    },
    {
      id: 'f2',
      key: 'comments',
      label: 'Comments',
      type: 'multiline',
      required: false,
      restricted: true,
      optionSetId: '',
      brandIds: ['b1'],
      active: false,
    },
  ],
  forms: [
    {
      id: 'fo1',
      key: 'deposits',
      name: 'Deposits',
      category: 'deposits',
      active: true,
      order: 0,
      entries: [
        {
          fieldKey: 'deposit_status',
          order: 0,
          conditionFieldKey: '',
          conditionValue: '',
          isSubcategorySource: true,
        },
      ],
    },
  ],
};

const EMPTY: FieldConfigWire = { optionSets: [], fields: [], forms: [] };

interface Stub extends DataAccess {
  writes: { op: string; resource: ResourceName; id?: string; payload?: unknown }[];
  reads: ResourceName[];
}

function stub(opts: { config?: FieldConfigWire; failWith?: unknown; failGets?: number } = {}): Stub {
  let getsLeftToFail = opts.failGets ?? 0;
  const s: Stub = {
    writes: [],
    reads: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      s.reads.push(resource);
      if (resource === 'brands') {
        return {
          items: [{ brandId: 'b1', name: 'Alpha', slug: 'alpha' }] as unknown as T[],
          nextCursor: null,
          hasMore: false,
        };
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(resource: ResourceName): Promise<T> {
      s.reads.push(resource);
      if (resource === 'admin-field-config') {
        if (getsLeftToFail > 0) {
          getsLeftToFail -= 1;
          throw { message: 'boom', retryable: true };
        }
        return (opts.config ?? CONFIG) as unknown as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      s.writes.push({ op: 'create', resource, payload: input });
      if (opts.failWith) throw opts.failWith;
      return {} as T;
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T> {
      s.writes.push({ op: 'update', resource, id, payload: patch });
      if (opts.failWith) throw opts.failWith;
      return {} as T;
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

function renderScreen(s: Stub, keys: string[] = ['platform.field.manage']) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={seed(keys) as never}>
      <TicketFields />
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

describe('one read projection feeds three tabs', () => {
  it('loading → ready: fields, sets and forms all render from the same read', async () => {
    const s = renderScreen(stub());

    // Loading first: the skeleton, never a blank or a premature «empty».
    expect(screen.queryByTestId('fields-list')).toBeNull();
    expect(s.container.querySelector('[aria-busy]')).not.toBeNull();

    const list = await screen.findByTestId('fields-list');
    expect(list).toHaveTextContent('Deposit status');
    // The badges say what a row IS: type, required, restricted, archived.
    expect(screen.getByTestId('field-deposit_status')).toHaveTextContent('required');
    expect(screen.getByTestId('field-comments')).toHaveTextContent('restricted');
    expect(screen.getByTestId('field-comments')).toHaveTextContent('archived');

    switchTab('tab-sets');
    expect(await screen.findByTestId('set-os1')).toHaveTextContent('Deposit status');
    expect(screen.getByTestId('set-os1')).toHaveTextContent('3 values');
    expect(screen.getByTestId('set-os1')).toHaveTextContent('used by 1 field');

    switchTab('tab-forms');
    expect(await screen.findByTestId('form-deposits')).toHaveTextContent('Deposits');
    expect(screen.getByTestId('form-deposits')).toHaveTextContent('1 field');
  });

  it('empty is an INVITATION with the create action present — never «No data»', async () => {
    renderScreen(stub({ config: EMPTY }));
    const empty = await screen.findByTestId('fields-empty');
    expect(empty).toHaveTextContent(/No fields yet/);
    expect(screen.getByTestId('field-new')).toBeInTheDocument();
    // Empty and broken must never look the same (§4): no error rendering here.
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('error renders the retry path, and retry re-reads into the ready list', async () => {
    renderScreen(stub({ failGets: 1 }));
    // The sanitized message + Retry (ErrorState), NOT the empty invitation.
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('fields-empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('fields-list')).toHaveTextContent('Deposit status');
  });
});

describe('writes go through the real resources and end in a re-read', () => {
  it('⭐ creates a field: POST body carries the whole definition, then the projection is re-read', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('field-new'));

    fireEvent.change(screen.getByTestId('field-label'), { target: { value: 'PSP' } });
    fireEvent.change(screen.getByTestId('field-type'), { target: { value: 'dropdown' } });
    fireEvent.change(await screen.findByTestId('field-option-set'), { target: { value: 'os1' } });
    fireEvent.click(screen.getByTestId('field-required'));
    fireEvent.click(screen.getByTestId('field-save'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'admin-field',
          payload: {
            label: 'PSP',
            type: 'dropdown',
            required: true,
            restricted: false,
            optionSetId: 'os1',
            brandIds: [],
            active: true,
          },
        }),
      ),
    );
    // The re-read (the W28 rule): nothing is merged locally, the server's word is fetched again.
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-field-config').length).toBeGreaterThanOrEqual(2),
    );
    // Success closes the editor.
    await waitFor(() => expect(screen.queryByTestId('field-form')).toBeNull());
  });

  it('archiving a field is a PATCH with active:false — the definition survives, nothing deletes', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('field-open-deposit_status'));
    fireEvent.click(await screen.findByTestId('field-archive'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'update',
          resource: 'admin-field',
          id: 'deposit_status',
          payload: expect.objectContaining({ active: false }),
        }),
      ),
    );
    expect(s.writes.filter((w) => w.op === 'remove')).toHaveLength(0);
  });

  it('a refused write is said IN WORDS beside the tabs, and the screen stays', async () => {
    const s = stub({ failWith: { message: 'a field with this name already exists', retryable: false } });
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('field-new'));
    fireEvent.change(screen.getByTestId('field-label'), { target: { value: 'Comments' } });
    fireEvent.click(screen.getByTestId('field-save'));

    expect(await screen.findByTestId('fields-mutation-error')).toHaveTextContent(
      'a field with this name already exists',
    );
    // The editor stays open with the admin's input — a refusal never eats their work.
    expect(screen.getByTestId('field-form')).toBeInTheDocument();
  });

  it('Escape closes the editor without a write (keyboard floor, §4)', async () => {
    const s = stub();
    renderScreen(s);
    fireEvent.click(await screen.findByTestId('field-new'));
    fireEvent.keyDown(screen.getByTestId('field-form'), { key: 'Escape' });
    expect(screen.queryByTestId('field-form')).toBeNull();
    expect(s.writes).toHaveLength(0);
  });
});

describe('option sets and forms author through their own resources', () => {
  it('saving a set sends the WHOLE ordered value list every time', async () => {
    const s = stub();
    renderScreen(s);
    await screen.findByTestId('fields-list');
    switchTab('tab-sets');

    fireEvent.click(await screen.findByTestId('set-new'));
    fireEvent.change(screen.getByTestId('set-name'), { target: { value: 'Countries' } });
    fireEvent.change(screen.getByTestId('set-value-0'), { target: { value: 'Argentina' } });
    fireEvent.click(screen.getByTestId('set-add-value'));
    fireEvent.change(screen.getByTestId('set-value-1'), { target: { value: 'Chile' } });
    fireEvent.click(screen.getByTestId('set-save'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'admin-option-set',
          payload: {
            name: 'Countries',
            values: [
              { value: 'Argentina', order: 0, active: true },
              { value: 'Chile', order: 1, active: true },
            ],
          },
        }),
      ),
    );
  });

  it('deleting a set asks in words first, then DELETEs — and the server’s 409 lands as words', async () => {
    const s = stub({ failWith: { message: 'the set is still read by a field', retryable: false } });
    renderScreen(s);
    await screen.findByTestId('fields-list');
    switchTab('tab-sets');
    fireEvent.click(await screen.findByTestId('set-open-os1'));

    fireEvent.click(await screen.findByTestId('set-delete'));
    // The confirmation names the consequence — 1 field reads from this set today.
    expect(await screen.findByText(/1 field still reads from this set/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('set-delete-confirm'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ op: 'remove', resource: 'admin-option-set', id: 'os1' }),
      ),
    );
    expect(await screen.findByTestId('fields-mutation-error')).toHaveTextContent(
      'the set is still read by a field',
    );
  });

  it('⭐ composes a form: picked fields, order via up/down, condition and source — one atomic save', async () => {
    const s = stub();
    renderScreen(s);
    await screen.findByTestId('fields-list');
    switchTab('tab-forms');

    fireEvent.click(await screen.findByTestId('form-new'));
    fireEvent.change(screen.getByTestId('form-name'), { target: { value: 'Withdrawals' } });
    fireEvent.change(screen.getByTestId('form-category'), { target: { value: 'withdrawals' } });
    // Only ACTIVE fields are offered: `comments` is archived, so the one candidate is the dropdown.
    const picker = screen.getByTestId('form-add-field');
    expect(picker).not.toHaveTextContent('Comments');
    fireEvent.change(picker, { target: { value: 'deposit_status' } });

    // The dropdown entry can be the sub-category source; the «none» radio proves ≤1 by construction.
    fireEvent.click(await screen.findByTestId('entry-source-0'));
    fireEvent.click(screen.getByTestId('form-save'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          op: 'create',
          resource: 'admin-form',
          payload: {
            name: 'Withdrawals',
            category: 'withdrawals',
            active: true,
            order: 1,
            entries: [
              {
                fieldKey: 'deposit_status',
                order: 0,
                conditionFieldKey: '',
                conditionValue: '',
                isSubcategorySource: true,
              },
            ],
          },
        }),
      ),
    );
  });
});

describe('⛔ the section is an administrator surface', () => {
  it('without platform.field.manage: the refusal in words, and NOT ONE request is fired', async () => {
    const s = stub();
    renderScreen(s, ['crm.inbox.view', 'crm.conversation.reply']);
    const denied = await screen.findByTestId('fields-denied');
    expect(denied).toHaveTextContent('platform.field.manage');
    expect(denied).toHaveTextContent('administrator');
    // The courtesy gate short-circuits the whole screen — reads AND writes (the W28 rule).
    expect(s.reads).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
    expect(screen.queryByTestId('field-new')).toBeNull();
  });
});
