import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { Statuses } from './statuses';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

/**
 * W15a — the status authoring screen (subpoint 3.14). Shape claims: grouping is BY CATEGORY (the
 * machine's word, and the screen's meaning), the create posts three fields and never a key, the
 * edit patches by key, retire is `active:false`, and a refusal is words beside the control.
 */

const WIRE = [
  { key: 'new', category: 'CONVERSATION_STATUS_CATEGORY_NEW', agentName: 'New', endUserName: 'Open', active: true, order: 10 },
  { key: 'open', category: 'CONVERSATION_STATUS_CATEGORY_OPEN', agentName: 'Open', endUserName: 'Open', active: true, order: 20 },
  { key: 'vip_pending', category: 'CONVERSATION_STATUS_CATEGORY_PENDING', agentName: 'VIP Pending', endUserName: 'VIP Pending', active: true, order: 30 },
  { key: 'auto_ended_chat', category: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD', agentName: 'Auto-Ended Chat', endUserName: 'Auto-Ended Chat', active: false, order: 40 },
];

interface Stub extends DataAccess {
  writes: Array<{ op: string; resource: ResourceName; id?: string; payload: unknown }>;
}

function stub(opts: { writeFails?: boolean } = {}): Stub {
  const writes: Stub['writes'] = [];
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    writes,
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'conversation-statuses') return page(WIRE as unknown as T[]);
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      writes.push({ op: 'create', resource, payload: input });
      if (opts.writeFails) throw { message: 'a status with this name already exists', retryable: false };
      return {} as T;
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T> {
      writes.push({ op: 'update', resource, id, payload: patch });
      if (opts.writeFails) throw { message: 'The request was not valid.', retryable: false };
      return {} as T;
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('not used');
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderStatuses(s: Stub, permissionKeys: string[] = ['crm.inbox.view', 'platform.settings.manage']) {
  setDataAccess(s);
  const seed: SessionState = { kind: 'authenticated', userId: 'me', accountId: 'a1', roles: ['admin'], permissionKeys };
  return render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <Statuses />
      </SessionProvider>
    </Providers>,
  );
}

describe('the catalogue, grouped by CATEGORY', () => {
  it('⭐ each status sits under its category, with both names and its immutable key', async () => {
    renderStatuses(stub());
    await screen.findByTestId('category-pending');
    expect(screen.getByTestId('category-pending')).toHaveTextContent('VIP Pending');
    expect(screen.getByTestId('status-vip_pending')).toHaveTextContent('vip_pending');
    // Dual naming is visible: the customer-facing word is its own column, not a tooltip.
    expect(screen.getByTestId('end-user-name-new')).toHaveTextContent('Open');
  });

  it('a retired status says what retirement MEANS, and offers Restore', async () => {
    renderStatuses(stub());
    await screen.findByTestId('retired-auto_ended_chat');
    expect(screen.getByTestId('retired-auto_ended_chat')).toHaveTextContent('old tickets keep the label');
    expect(screen.getByTestId('status-toggle-auto_ended_chat')).toHaveTextContent('Restore');
  });

  it('⛔ below `platform.settings.manage` the catalogue is READ-ONLY — controls absent, not disabled', async () => {
    // A teamlead legitimately READS the vocabulary (crm.inbox.view); what they cannot do is change
    // what it means, and a control every teamlead can only 403 with is noise (the W14 rule).
    renderStatuses(stub(), ['crm.inbox.view']);
    await screen.findByTestId('category-pending');
    expect(screen.queryByTestId('status-create-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('status-edit-vip_pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('status-toggle-vip_pending')).not.toBeInTheDocument();
  });
});

describe('creating a status', () => {
  it('posts category + the two names — and NO key: the key is the server’s derivation', async () => {
    const s = stub();
    renderStatuses(s);
    fireEvent.click(await screen.findByTestId('status-create-open'));
    fireEvent.keyDown(screen.getByTestId('status-create-category'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'pending' }));
    fireEvent.change(screen.getByTestId('status-create-agent-name'), { target: { value: 'Waiting on Finance' } });
    fireEvent.change(screen.getByTestId('status-create-end-user-name'), { target: { value: 'In review' } });
    fireEvent.click(screen.getByTestId('status-create-save'));

    await screen.findByTestId('status-create-done');
    expect(s.writes[0]).toMatchObject({
      op: 'create',
      resource: 'admin-statuses',
      payload: { category: 'pending', agentName: 'Waiting on Finance', endUserName: 'In review' },
    });
    expect(Object.keys(s.writes[0]!.payload as object)).not.toContain('key');
  });

  it('a conflict (duplicate name) stays beside the form, which stays open', async () => {
    renderStatuses(stub({ writeFails: true }));
    fireEvent.click(await screen.findByTestId('status-create-open'));
    fireEvent.keyDown(screen.getByTestId('status-create-category'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'open' }));
    fireEvent.change(screen.getByTestId('status-create-agent-name'), { target: { value: 'Open' } });
    fireEvent.change(screen.getByTestId('status-create-end-user-name'), { target: { value: 'Open' } });
    fireEvent.click(screen.getByTestId('status-create-save'));

    expect(await screen.findByTestId('status-create-error')).toHaveTextContent('already exists');
    expect(screen.getByTestId('status-create-form')).toBeInTheDocument();
  });
});

describe('editing a status', () => {
  it('⭐ patches by KEY; the category rides only when it MOVED (the server refuses a no-op)', async () => {
    const s = stub();
    renderStatuses(s);
    fireEvent.click(await screen.findByTestId('status-edit-vip_pending'));
    fireEvent.change(screen.getByTestId('edit-agent-name-vip_pending'), { target: { value: 'VIP waiting' } });
    fireEvent.click(screen.getByTestId('status-save-vip_pending'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      op: 'update',
      resource: 'admin-statuses',
      id: 'vip_pending',
      payload: { agentName: 'VIP waiting', endUserName: 'VIP Pending' },
    });
    expect(Object.keys(s.writes[0]!.payload as object)).not.toContain('category');
  });

  it('Retire sends exactly `{active: false}` — an update, never a delete', async () => {
    const s = stub();
    renderStatuses(s);
    fireEvent.click(await screen.findByTestId('status-toggle-vip_pending'));
    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({ op: 'update', id: 'vip_pending', payload: { active: false } });
  });
});
