import { configureStore } from '@reduxjs/toolkit';
import createSagaMiddleware from 'redux-saga';
import { all, fork } from 'redux-saga/effects';
import { waitFor } from '@testing-library/react';
import { recordsReducer, recordsActions } from './records.slice';
import { recordsSaga } from './records.sagas';
import { setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult } from '@/data/types';

// T015 [US2] — the saga: success→ready, empty→empty, raw error→sanitized, takeLatest cancels stale.

function makeTestStore() {
  const sm = createSagaMiddleware();
  const store = configureStore({
    reducer: { records: recordsReducer },
    middleware: (g) => g({ thunk: false }).concat(sm),
  });
  sm.run(function* () {
    yield all([fork(recordsSaga)]);
  });
  return store;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('records saga', () => {
  it('load → ready on success', async () => {
    setDataAccess(new MockDataAccess({ count: 5 }));
    const store = makeTestStore();
    store.dispatch(recordsActions.load({ limit: 10 }));
    await waitFor(() => expect(store.getState().records.status).toBe('ready'));
  });

  it('load → empty when nothing matches', async () => {
    setDataAccess(new MockDataAccess({ count: 5 }));
    const store = makeTestStore();
    store.dispatch(recordsActions.load({ limit: 10, filters: { status: 'nope' } }));
    await waitFor(() => expect(store.getState().records.status).toBe('empty'));
  });

  it('sanitizes a raw thrown error (no PII/secret leaks into state)', async () => {
    const leaky: DataAccess = {
      list: async () => {
        throw new Error('token=SUPER_SECRET_ABC123 leaked');
      },
      get: async () => ({}) as never,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      remove: async () => {},
    };
    setDataAccess(leaky);
    const store = makeTestStore();
    store.dispatch(recordsActions.load({ limit: 10 }));
    await waitFor(() => expect(store.getState().records.status).toBe('error'));
    const s = store.getState().records;
    if (s.status === 'error') {
      expect(s.error.message).not.toMatch(/SUPER_SECRET|token=/);
    }
  });

  it('takeLatest: a superseded request never overwrites the latest', async () => {
    let call = 0;
    const staged: DataAccess = {
      list: async <T,>(): Promise<PaginatedResult<T>> => {
        call += 1;
        const n = call;
        if (n === 1) await sleep(60); // first (stale) resolves later
        return { items: [{ id: String(n) } as unknown as T], nextCursor: null, hasMore: false };
      },
      get: async () => ({}) as never,
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      remove: async () => {},
    };
    setDataAccess(staged);
    const store = makeTestStore();
    store.dispatch(recordsActions.load({ limit: 10 })); // call #1 (slow)
    await sleep(5);
    store.dispatch(recordsActions.load({ limit: 10, cursor: 'x' })); // call #2 (fast) — latest
    await waitFor(() => expect(store.getState().records.status).toBe('ready'));
    await sleep(80); // let the slow #1 resolve; its handler must have been cancelled
    const s = store.getState().records;
    if (s.status === 'ready') expect(s.data.items[0]!.id).toBe('2');
  });
});
