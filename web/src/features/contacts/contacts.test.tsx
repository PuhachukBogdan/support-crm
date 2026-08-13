import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Contacts } from './contacts';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, Query, ResourceName } from '@/data/types';

/**
 * W11 — the customer directory (roadmap 9.17). Shape claims: what it asks for, and — more
 * important — what it refuses to offer.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

interface Stub extends DataAccess {
  calls: Array<{ resource: ResourceName; query: Query }>;
}

function stub(opts: { rows?: { playerId: string }[]; listError?: unknown } = {}): Stub {
  const calls: Array<{ resource: ResourceName; query: Query }> = [];
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    calls,
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      calls.push({ resource, query });
      if (resource === 'brands') {
        return page([
          { brandId: 'brand-a', name: 'Brand A', slug: 'a' },
          { brandId: 'brand-b', name: 'Brand B', slug: 'b' },
        ] as unknown as T[]);
      }
      if (resource === 'players') {
        if (opts.listError) throw opts.listError;
        return page((opts.rows ?? [{ playerId: 'ply-1', accountId: 'a', brandId: 'brand-a' }]) as unknown as T[]);
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

function renderDirectory(s: Stub) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Contacts />
    </Providers>,
  );
}

beforeEach(() => push.mockClear());

describe('the directory asks about ONE brand, and searches by ID', () => {
  it('defaults to the first brand and lists it', async () => {
    const s = stub();
    renderDirectory(s);
    await screen.findByText('ply-1');
    const playersCall = s.calls.find((c) => c.resource === 'players');
    expect(playersCall?.query.filters).toMatchObject({ brandId: 'brand-a' });
  });

  it('switching brand re-asks for the other brand — there is no "all brands"', async () => {
    const s = stub();
    renderDirectory(s);
    await screen.findByText('ply-1');
    fireEvent.click(screen.getByTestId('brand-brand-b'));
    await waitFor(() =>
      expect(s.calls.filter((c) => c.resource === 'players').at(-1)?.query.filters).toMatchObject({
        brandId: 'brand-b',
      }),
    );
  });

  it('⭐ search sends a playerIdPrefix — and the box says so', async () => {
    const s = stub();
    renderDirectory(s);
    await screen.findByText('ply-1');

    const box = screen.getByTestId('player-id-search');
    // ⛔ The label names the ID, so nobody types a phone number expecting the answer that W9
    // deliberately keeps inside a conversation.
    expect(box).toHaveAttribute('aria-label', 'Search by player ID');
    fireEvent.change(box, { target: { value: 'ply-4' } });
    fireEvent.click(screen.getByTestId('player-id-search-go'));

    await waitFor(() =>
      expect(s.calls.filter((c) => c.resource === 'players').at(-1)?.query.filters).toMatchObject({
        playerIdPrefix: 'ply-4',
      }),
    );
  });

  it('⛔ the screen composes NO contact filter, ever', async () => {
    const s = stub();
    renderDirectory(s);
    await screen.findByText('ply-1');
    for (const call of s.calls.filter((c) => c.resource === 'players')) {
      const keys = Object.keys(call.query.filters ?? {});
      expect(keys).not.toContain('email');
      expect(keys).not.toContain('phone');
      expect(keys).not.toContain('q');
    }
  });

  it('a row opens the player page with BOTH segments — an id alone names two people', async () => {
    const s = stub();
    renderDirectory(s);
    fireEvent.click(await screen.findByText('ply-1'));
    expect(push).toHaveBeenCalledWith('/players/brand-a/ply-1');
  });
});

describe('⭐ the refusal is a refusal', () => {
  it('a non-retryable error renders the role message, NOT an empty table', async () => {
    const s = stub({ listError: { message: 'forbidden', retryable: false } });
    renderDirectory(s);
    const refusal = await screen.findByTestId('directory-refused');
    expect(refusal).toHaveTextContent('not available to your role');
    // ⛔ An empty table would read as "this brand has no customers" — a confidently wrong answer.
    expect(screen.queryByTestId('dt-empty')).not.toBeInTheDocument();
  });
});
