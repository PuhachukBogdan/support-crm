import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Access } from './access';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

/**
 * ⭐⭐ W28 (9.8, R45) — Access Management as ONE window: who on the left, what on the right, roles
 * and permissions in the same session. The claims that MOVED here with the role control (from
 * people.test.tsx, the W8 rule) are marked; enforcement claims stay the server's — these tests pin
 * the questions the screen asks, never who may ask them.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const CATALOGUE = {
  categories: [
    {
      category: 'crm',
      permissions: [
        { key: 'crm.inbox.view', label: 'View inbox' },
        { key: 'crm.customers.browse', label: 'Browse the customer directory' },
      ],
    },
    {
      category: 'platform',
      permissions: [{ key: 'platform.audit.view', label: 'View audit log' }],
    },
  ],
};

const STAFF = [
  { userId: 'u1', email: 'nina@example.test', displayName: 'Nina', status: 'active', roleKey: 'support_agent', inheritsRole: true },
  { userId: 'u2', email: 'oleg@example.test', displayName: '', status: 'active', roleKey: 'support_agent', inheritsRole: false },
  { userId: 'u3', email: 'lead@example.test', displayName: 'Lead', status: 'active', roleKey: 'teamlead', inheritsRole: true },
];

const GROUPS = [
  { id: 'g1', name: 'VIP desk', active: true, memberCount: 2, permissionKeys: ['crm.customers.browse'] },
];

interface StubOptions {
  personPerms?: { roleKey: string; mode: string; effectiveKeys: string[]; baseKeys: string[]; groupKeys: string[] };
  failWriteWith?: unknown;
}

interface Stub extends DataAccess {
  writes: { op: string; resource: ResourceName; id?: string; payload?: unknown; within?: string }[];
  reads: ResourceName[];
}

function stub(opts: StubOptions = {}): Stub {
  const s: Stub = {
    writes: [],
    reads: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      s.reads.push(resource);
      if (resource === 'staff') return { items: STAFF as unknown as T[], nextCursor: null, hasMore: false };
      if (resource === 'groups') return { items: GROUPS as unknown as T[], nextCursor: null, hasMore: false };
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(resource: ResourceName, id: string): Promise<T> {
      s.reads.push(resource);
      if (resource === 'access-catalogue') return CATALOGUE as unknown as T;
      if (resource === 'staff-permissions') {
        return (opts.personPerms ?? {
          roleKey: 'support_agent',
          mode: 'inherited',
          effectiveKeys: ['crm.inbox.view', 'crm.customers.browse'],
          baseKeys: ['crm.inbox.view'],
          groupKeys: ['crm.customers.browse'],
        }) as unknown as T;
      }
      if (resource === 'role-defaults') {
        return { permissionKeys: id === 'teamlead' ? ['crm.inbox.view', 'platform.audit.view'] : ['crm.inbox.view'] } as unknown as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      s.writes.push({ op: 'create', resource, payload: input });
      if (opts.failWriteWith) throw opts.failWriteWith;
      return {} as T;
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T> {
      s.writes.push({ op: 'update', resource, id, payload: patch, within });
      if (opts.failWriteWith) throw opts.failWriteWith;
      return {} as T;
    },
    async remove<T = void>(resource: ResourceName, id: string, within?: string): Promise<T> {
      s.writes.push({ op: 'remove', resource, id, within });
      if (opts.failWriteWith) throw opts.failWriteWith;
      return undefined as T;
    },
    subscribe(): () => void {
      return () => {};
    },
  };
  return s;
}

const seed = (keys: string[]) =>
  ({
    kind: 'authenticated',
    userId: 'me',
    accountId: 'a1',
    roles: keys.includes('platform.role.manage') ? ['super_admin'] : ['teamlead'],
    permissionKeys: keys,
  }) as const;

function renderAccess(s: Stub, keys: string[] = ['platform.role.manage', 'users.list.view']) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={seed(keys) as never}>
      <Access />
    </Providers>,
  );
}

afterEach(() => setDataAccess(new MockDataAccess()));

/** Radix Tabs activate on POINTER-DOWN (jsdom's click alone is not a pointer sequence). */
function switchTab(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
}

describe('⛔ the section is a super-admin surface', () => {
  it('without the exclusive key: the refusal panel, and NOT ONE data read is fired', async () => {
    const s = stub();
    renderAccess(s, ['users.list.view', 'crm.inbox.view']);
    expect(await screen.findByTestId('access-denied')).toBeInTheDocument();
    // The courtesy gate short-circuits the whole window — a 403 storm is not a render strategy.
    expect(s.reads).toHaveLength(0);
  });
});

describe('⭐ the one window: who on the left, what on the right', () => {
  it('renders people with role + personalised badges, and the grid waits for a subject', async () => {
    renderAccess(stub());
    expect(await screen.findByTestId('access-people')).toBeInTheDocument();
    expect(screen.getByTestId('access-empty')).toBeInTheDocument();
    expect(await screen.findByTestId('person-u2')).toHaveTextContent('personalised');
  });

  it('⭐ PERSON scope: the switch is the BASE term; a group-granted key is a chip, never a switch that lies', async () => {
    renderAccess(stub());
    fireEvent.click(await screen.findByTestId('person-u1'));

    await screen.findByTestId('perm-crm.inbox.view');
    // base key → switch on; group key → chip + switch OFF (the base does not hold it).
    expect(screen.getByTestId('switch-crm.inbox.view')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('via-group-crm.customers.browse')).toBeInTheDocument();
    expect(screen.getByTestId('switch-crm.customers.browse')).toHaveAttribute('data-state', 'unchecked');
  });

  it('toggling writes the person path and re-reads — nothing is merged locally', async () => {
    const s = stub();
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('person-u1'));
    fireEvent.click(await screen.findByTestId('switch-platform.audit.view'));

    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          resource: 'staff-permissions',
          id: 'u1',
          payload: { permissionKey: 'platform.audit.view', grant: true },
        }),
      ),
    );
    // The re-read: the person's facts are fetched again after the write (the truth is the server's).
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'staff-permissions').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('⭐ MOVED CLAIM: the role is handed out HERE — staff-role with op=assign, super_admin not offered', async () => {
    const s = stub();
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('person-u1'));
    fireEvent.keyDown(await screen.findByTestId('role-menu'), { key: 'Enter' });

    expect(screen.queryByTestId('assign-role-super_admin')).toBeNull(); // 0033/FR-018
    fireEvent.click(await screen.findByTestId('assign-role-teamlead'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          resource: 'staff-role',
          id: 'u1',
          payload: { roleKey: 'teamlead', op: 'assign' },
        }),
      ),
    );
  });

  it('⭐ MOVED CLAIM: a refusal is said beside the grid, and the window stays', async () => {
    const s = stub({ failWriteWith: { message: 'forbidden', retryable: false } });
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('person-u1'));
    fireEvent.click(await screen.findByTestId('switch-platform.audit.view'));

    expect(await screen.findByTestId('access-mutation-error')).toHaveTextContent('forbidden');
    expect(screen.getByTestId('access-people')).toBeInTheDocument();
  });

  it('ROLE scope: the template grid, edits go to role-permissions, and super_admin is not a row', async () => {
    const s = stub();
    renderAccess(s);
    await screen.findByTestId('access-people');
    switchTab('tab-roles');
    expect(screen.queryByTestId('role-super_admin')).toBeNull();
    fireEvent.click(await screen.findByTestId('role-teamlead'));

    await screen.findByTestId('perm-platform.audit.view');
    expect(screen.getByTestId('switch-platform.audit.view')).toHaveAttribute('data-state', 'checked');
    fireEvent.click(screen.getByTestId('switch-crm.customers.browse'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          resource: 'role-permissions',
          id: 'teamlead',
          payload: { permissionKey: 'crm.customers.browse', grant: true },
        }),
      ),
    );
  });

  it('GROUP scope: grants are per-key rows — PUT to add, DELETE to remove (0039, grants only)', async () => {
    const s = stub();
    renderAccess(s);
    await screen.findByTestId('access-people');
    switchTab('tab-groups');
    fireEvent.click(await screen.findByTestId('group-g1'));

    await screen.findByTestId('perm-crm.customers.browse');
    expect(screen.getByTestId('switch-crm.customers.browse')).toHaveAttribute('data-state', 'checked');
    fireEvent.click(screen.getByTestId('switch-crm.customers.browse')); // off → DELETE
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ op: 'remove', resource: 'group-permissions', id: 'crm.customers.browse', within: 'g1' }),
      ),
    );
    fireEvent.click(screen.getByTestId('switch-crm.inbox.view')); // on → PUT
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ op: 'update', resource: 'group-permissions', id: 'crm.inbox.view', within: 'g1' }),
      ),
    );
  });

  it('⭐ SELECTION scope: actions, not switches — and a cross-role batch is warned off BEFORE the 409', async () => {
    const s = stub();
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('select-u1'));
    fireEvent.click(await screen.findByTestId('select-u2'));

    await screen.findByTestId('grant-crm.inbox.view');
    expect(screen.queryByTestId('switch-crm.inbox.view')).toBeNull(); // no single truth to show
    fireEvent.click(screen.getByTestId('grant-crm.inbox.view'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({
          resource: 'selection-permissions',
          payload: { userIds: ['u1', 'u2'], permissionKey: 'crm.inbox.view', grant: true },
        }),
      ),
    );

    // Add the teamlead: the selection now spans two roles — FR-011 surfaced, actions disabled.
    fireEvent.click(screen.getByTestId('select-u3'));
    expect(await screen.findByTestId('cross-role-warning')).toBeInTheDocument();
    expect(screen.getByTestId('grant-crm.inbox.view')).toBeDisabled();
  });

  it('«вернуть как было» at each scope hits the engine reset with the scope’s own words', async () => {
    const s = stub();
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('person-u1'));
    fireEvent.click(await screen.findByTestId('reset-scope'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ resource: 'access-reset', payload: { scope: 'user', userId: 'u1' } }),
      ),
    );

    switchTab('tab-roles');
    fireEvent.click(await screen.findByTestId('role-support_agent'));
    fireEvent.click(await screen.findByTestId('reset-scope'));
    await waitFor(() =>
      expect(s.writes).toContainEqual(
        expect.objectContaining({ resource: 'access-reset', payload: { scope: 'role', roleKey: 'support_agent' } }),
      ),
    );
  });

  it('the permission search narrows the grid without touching the wire', async () => {
    const s = stub();
    renderAccess(s);
    fireEvent.click(await screen.findByTestId('person-u1'));
    await screen.findByTestId('perm-crm.inbox.view');
    const writesBefore = s.writes.length;

    fireEvent.change(screen.getByTestId('perm-search'), { target: { value: 'audit' } });
    expect(screen.queryByTestId('perm-crm.inbox.view')).toBeNull();
    expect(screen.getByTestId('perm-platform.audit.view')).toBeInTheDocument();
    expect(s.writes.length).toBe(writesBefore);
  });
});
