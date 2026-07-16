import { createAsyncListSlice } from './create-async-slice';
import type { PaginatedResult } from '@/data/types';

// T014 [US2] — the shared AsyncState transitions.

type Row = { id: string };
const page = (items: Row[]): PaginatedResult<Row> => ({
  items,
  nextCursor: null,
  hasMore: false,
});

describe('createAsyncListSlice — AsyncState transitions', () => {
  const { reducer, actions } = createAsyncListSlice<Row>('t');

  it('starts idle', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual({ status: 'idle' });
  });

  it('idle → loading on load', () => {
    const s = reducer({ status: 'idle' }, actions.load({ limit: 10 }));
    expect(s).toEqual({ status: 'loading' });
  });

  it('loading → ready on non-empty success', () => {
    const s = reducer({ status: 'loading' }, actions.succeeded(page([{ id: '1' }])));
    expect(s.status).toBe('ready');
    if (s.status === 'ready') expect(s.data.items).toHaveLength(1);
  });

  it('loading → empty on empty success', () => {
    const s = reducer({ status: 'loading' }, actions.succeeded(page([])));
    expect(s).toEqual({ status: 'empty' });
  });

  it('loading → error on failure', () => {
    const s = reducer({ status: 'loading' }, actions.failed({ message: 'x', retryable: true }));
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.error.retryable).toBe(true);
  });

  it('resets to idle', () => {
    expect(reducer({ status: 'empty' }, actions.reset())).toEqual({ status: 'idle' });
  });
});
