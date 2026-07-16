import { render, screen } from '@testing-library/react';
import { DataAccessProvider } from './provider';
import { useList } from './use-resource';
import { MockDataAccess } from './mock/mock-data-access';
import type { DataAccess } from './data-access';
import type { PaginatedResult } from './types';

// T007 [US1] — the same consumer renders whatever implementation is bound (SC-001).

type Row = { id: string; subject: string };

// One unchanging consumer component — proves the swap needs no consumer edit.
function RecordList() {
  const state = useList<Row>('records', { limit: 5 });
  if (state.status !== 'ready') return <div>state: {state.status}</div>;
  return (
    <ul>
      {state.data.items.map((r) => (
        <li key={r.id}>{r.subject}</li>
      ))}
    </ul>
  );
}

const stub: DataAccess = {
  list: async <T,>(): Promise<PaginatedResult<T>> => ({
    items: [{ id: 'x', subject: 'Stub row' } as unknown as T],
    nextCursor: null,
    hasMore: false,
  }),
  get: async () => ({}) as never,
  create: async () => ({}) as never,
  update: async () => ({}) as never,
  remove: async () => {},
};

describe('DataAccessProvider — swappable implementation', () => {
  it('renders mock data, then stub data after rebinding, with no consumer change', async () => {
    const { rerender } = render(
      <DataAccessProvider impl={new MockDataAccess({ count: 5 })}>
        <RecordList />
      </DataAccessProvider>,
    );
    expect(await screen.findByText('Demo request #1')).toBeInTheDocument();

    // Swap ONLY the bound implementation — RecordList is byte-for-byte the same component.
    rerender(
      <DataAccessProvider impl={stub}>
        <RecordList />
      </DataAccessProvider>,
    );
    expect(await screen.findByText('Stub row')).toBeInTheDocument();
  });
});
