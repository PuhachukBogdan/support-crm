import { call, put, takeLatest } from 'redux-saga/effects';
import type { ActionCreatorWithPayload, ActionCreatorWithPreparedPayload } from '@reduxjs/toolkit';
import { getDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { PaginatedResult, Query, ResourceName, DataError } from '@/data/types';

type ListActions<T> = {
  load: ActionCreatorWithPreparedPayload<[Query], Query>;
  succeeded: ActionCreatorWithPayload<PaginatedResult<T>>;
  failed: ActionCreatorWithPayload<DataError>;
};

/**
 * Build the watcher saga for a list domain. `takeLatest` guarantees a superseded request's
 * handler is cancelled, so a stale response can never overwrite newer state. The DataAccess
 * impl is resolved at call time, so it always uses the current binding.
 */
export function makeListSaga<T>(resource: ResourceName, actions: ListActions<T>) {
  function* handleLoad(action: { type: string; payload: Query }) {
    try {
      const da = getDataAccess();
      const res: PaginatedResult<T> = yield call([da, da.list], resource, action.payload);
      yield put(actions.succeeded(res));
    } catch (e) {
      yield put(actions.failed(toDataError(e)));
    }
  }

  return function* watch() {
    yield takeLatest(actions.load.type, handleLoad);
  };
}
