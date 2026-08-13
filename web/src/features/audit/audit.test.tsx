import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Audit } from './audit';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, Query, ResourceName } from '@/data/types';

/**
 * W16 — the audit table (subpoint 3.12). Shape claims: rows render with the actor JOINED to an
 * email, the class filter narrows the QUERY (and resets the cursor), Load more continues it, and a
 * refusal is words.
 */

const ENTRIES = [
  {
    id: 'e1',
    actorUserId: 'u1',
    actorKind: 'ACTOR_KIND_USER',
    action: 'role.assign',
    targetRef: 'u2',
    detailJson: '{"roleKey":"teamlead"}',
    createdAt: '2026-08-07T10:00:00.000Z',
    source: 'auth',
  },
  {
    id: 'e2',
    actorKind: 'ACTOR_KIND_SYSTEM',
    actorRef: 'mail-sweep',
    action: 'channel.intake_refused',
    targetRef: 'ch-1',
    detailJson: '',
    createdAt: '2026-08-07T09:00:00.000Z',
    source: 'chats',
  },
];

interface Stub extends DataAccess {
  queries: Query[];
}

function stub(opts: { fails?: boolean; nextCursor?: string | null } = {}): Stub {
  const queries: Query[] = [];
  return {
    queries,
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      if (resource === 'audit-entries') {
        if (opts.fails) throw { message: 'You do not have access to this.', retryable: false };
        queries.push(query);
        return { items: ENTRIES as unknown as T[], nextCursor: opts.nextCursor ?? null, hasMore: !!opts.nextCursor };
      }
      if (resource === 'staff') {
        return {
          items: [{ userId: 'u1', email: 'ann@example.test' }] as unknown as T[],
          nextCursor: null,
          hasMore: false,
        };
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async update<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('not used');
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderAudit(s: Stub) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Audit />
    </Providers>,
  );
}

describe('the audit table', () => {
  it('⭐ renders entries with the HUMAN actor joined to an email and the SYSTEM actor named by ref', async () => {
    renderAudit(stub());
    await screen.findByTestId('audit-list');
    expect(screen.getByTestId('audit-actor-e1')).toHaveTextContent('ann@example.test');
    expect(screen.getByTestId('audit-actor-e2')).toHaveTextContent('system (mail-sweep)');
    // The PII-free detail is readable, not hidden behind a tooltip.
    expect(screen.getByTestId('audit-e1')).toHaveTextContent('roleKey=teamlead');
  });

  it('⭐ the class filter narrows the QUERY and starts from page one', async () => {
    const s = stub({ nextCursor: 'page-2' });
    renderAudit(s);
    await screen.findByTestId('audit-list');
    expect(s.queries[0]!.filters).toEqual({});

    fireEvent.keyDown(screen.getByTestId('audit-class-filter'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'privilege' }));

    await waitFor(() => expect(s.queries).toHaveLength(2));
    expect(s.queries[1]).toMatchObject({ filters: { actionClass: 'privilege' }, cursor: null });
  });

  it('Load more continues under the SAME class with the cursor', async () => {
    const s = stub({ nextCursor: 'page-2' });
    renderAudit(s);
    fireEvent.click(await screen.findByTestId('audit-more'));
    await waitFor(() => expect(s.queries).toHaveLength(2));
    expect(s.queries[1]!.cursor).toBe('page-2');
  });

  it('a refusal is WORDS, never an empty table', async () => {
    renderAudit(stub({ fails: true }));
    expect(await screen.findByTestId('audit-error')).toHaveTextContent('do not have access');
    expect(screen.queryByTestId('audit-list')).not.toBeInTheDocument();
  });
});
