import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { People } from './people';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, Query, ResourceName } from '@/data/types';

/**
 * W14 — People & groups (roadmap 3.8 + 3.9). Shape claims: what the screen composes, and which
 * controls it offers to whom.
 *
 * ⚠️ Read every title as "…is not RENDERED", never "…is not permitted". The role change is
 * super-admin-only IN THE SERVER (auth re-checks after the gateway), and the live round proves the
 * refusal; a hidden button proves nothing about a crafted request.
 */

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

interface Stub extends DataAccess {
  writes: Array<{ op: string; resource: ResourceName; id?: string; payload?: unknown; within?: string }>;
}

function stub(opts: { roleFails?: boolean; groupsFail?: boolean; inviteFails?: boolean } = {}): Stub {
  const writes: Stub['writes'] = [];
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    writes,
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      if (resource === 'staff') {
        return page([
          { userId: 'u1', email: 'ann@example.test', displayName: 'Ann', status: 'active', roleKey: 'support_agent' },
          { userId: 'u2', email: 'bob@example.test', displayName: '', status: 'invited', roleKey: '' },
        ] as unknown as T[]);
      }
      if (resource === 'groups') {
        if (opts.groupsFail) throw { message: 'forbidden', retryable: false };
        return page([{ id: 'g1', name: 'Desk A', active: true, memberCount: 1 }] as unknown as T[]);
      }
      if (resource === 'group-members') {
        expect(query.within).toBe('g1');
        return page(['u1'] as unknown as T[]);
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      writes.push({ op: 'create', resource, payload: input });
      if (resource === 'invites' && opts.inviteFails)
        throw { message: 'Too many attempts in a row. Wait a minute, then try again.', retryable: true };
      return { status: 'created', invitationId: 'inv1' } as T;
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T> {
      writes.push({ op: 'update', resource, id, payload: patch, within });
      if (resource === 'staff-role' && opts.roleFails) throw { message: 'forbidden', retryable: false };
      return {} as T;
    },
    async remove<T = void>(resource: ResourceName, id: string, within?: string): Promise<T> {
      writes.push({ op: 'remove', resource, id, within });
      return undefined as T;
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderPeople(s: Stub, roles: string[]) {
  setDataAccess(s);
  const seed: SessionState = { kind: 'authenticated', userId: 'me', accountId: 'a1', roles, permissionKeys: [] };
  return render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <People />
      </SessionProvider>
    </Providers>,
  );
}

describe('the people list', () => {
  it('renders each person by EMAIL with their role and status', async () => {
    renderPeople(stub(), ['super_admin']);
    await screen.findByTestId('people-list');
    expect(screen.getByTestId('person-u1')).toHaveTextContent('ann@example.test');
    expect(screen.getByTestId('role-u1')).toHaveTextContent('support_agent');
    // Somebody with no role reads as "no role" rather than as a blank that looks like a bug.
    expect(screen.getByTestId('role-u2')).toHaveTextContent('no role');
    // …and their invited state is visible, because it explains why they cannot sign in yet.
    expect(screen.getByTestId('person-u2')).toHaveTextContent('invited');
  });
});

describe('⭐ W28 (R45): the role control MOVED to Access Management — this screen points, never edits', () => {
  /**
   * ⚠️ The old claims did not evaporate, they TRAVELLED (the W8 rule: a check moves with its
   * subject): "the role write goes to staff-role with op=assign" and "a refusal shows beside the
   * grid" are asserted in `features/access/access.test.tsx` now — where the control lives.
   */
  it('a super-admin gets the way IN — the link to the one window that edits access', async () => {
    renderPeople(stub(), ['super_admin']);
    await screen.findByTestId('people-list');
    expect(screen.queryByTestId('set-role-u1')).not.toBeInTheDocument(); // the control is GONE
    expect(screen.getByTestId('access-link-u1')).toHaveAttribute('href', '/admin/access');
  });

  it('⛔ a teamlead sees the list and NO way in — it is an ownership act, not a supervisory one', async () => {
    renderPeople(stub(), ['teamlead']);
    await screen.findByTestId('people-list');
    expect(screen.queryByTestId('set-role-u1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('access-link-u1')).not.toBeInTheDocument();
  });
});

describe('the invite form (W14 remainder, roadmap 3.8)', () => {
  it('an admin invites by email + role, and the outcome is said beside the form', async () => {
    const s = stub();
    renderPeople(s, ['admin']);
    fireEvent.click(await screen.findByTestId('invite-open'));

    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByTestId('invite-send'));

    expect(await screen.findByTestId('invite-sent')).toBeInTheDocument();
    // The default role is the first invitable one — the common case, pickable away.
    expect(s.writes.at(-1)).toMatchObject({
      op: 'create',
      resource: 'invites',
      payload: { email: 'new@example.test', role: 'support_agent' },
    });
    // Cleared, not closed: inviting several people in a row is the ordinary admin session.
    expect(screen.getByTestId('invite-email')).toHaveValue('');
  });

  it('a refusal keeps the form open and says WHY — a rate limit must not read as "try again now"', async () => {
    renderPeople(stub({ inviteFails: true }), ['super_admin']);
    fireEvent.click(await screen.findByTestId('invite-open'));
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByTestId('invite-send'));

    expect(await screen.findByTestId('invite-error')).toHaveTextContent('Wait a minute');
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
  });

  it('⛔ below admin there is no invite entry point at all — absence, not a disabled button', async () => {
    renderPeople(stub(), ['teamlead']);
    await screen.findByTestId('people-list');
    expect(screen.queryByTestId('invite-open')).not.toBeInTheDocument();
  });

  it('an admin may not offer the admin role — only a super-admin may (mirrors canInvite)', async () => {
    renderPeople(stub(), ['admin']);
    fireEvent.click(await screen.findByTestId('invite-open'));
    fireEvent.keyDown(screen.getByTestId('invite-role'), { key: 'Enter' });
    expect(await screen.findByText('teamlead')).toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });
});

describe('desks', () => {
  it('membership toggles by user id under the desk', async () => {
    const s = stub();
    renderPeople(s, ['super_admin']);
    fireEvent.click(await screen.findByTestId('group-open-g1'));
    await screen.findByTestId('group-members-g1');

    // u1 is a member ⇒ the control removes; u2 is not ⇒ it adds.
    fireEvent.click(screen.getByTestId('member-toggle-g1-u2'));
    await waitFor(() =>
      expect(s.writes.at(-1)).toMatchObject({ op: 'update', resource: 'group-members', id: 'u2', within: 'g1' }),
    );
    fireEvent.click(screen.getByTestId('member-toggle-g1-u1'));
    await waitFor(() =>
      expect(s.writes.at(-1)).toMatchObject({ op: 'remove', resource: 'group-members', id: 'u1', within: 'g1' }),
    );
  });

  it('⭐ desks failing does NOT blank the people list — they are different permissions', async () => {
    renderPeople(stub({ groupsFail: true }), ['super_admin']);
    await screen.findByTestId('people-list');
    expect(screen.getByTestId('groups-error')).toHaveTextContent('not available to your role');
    expect(screen.getByTestId('person-u1')).toBeInTheDocument();
  });
});
