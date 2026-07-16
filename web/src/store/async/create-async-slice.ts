import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AsyncState, DataError, PaginatedResult, Query } from '@/data/types';

/**
 * Factory for a domain "list" slice holding the shared AsyncState<PaginatedResult<T>>.
 * The `load` action is the saga trigger (also flips state to loading); `succeeded` maps an
 * empty page to `empty`, a non-empty page to `ready`; `failed` carries a sanitized DataError.
 */
export function createAsyncListSlice<T>(name: string) {
  const initialState = { status: 'idle' } as AsyncState<PaginatedResult<T>>;

  const slice = createSlice({
    name,
    initialState,
    reducers: {
      load: {
        reducer: (): AsyncState<PaginatedResult<T>> => ({ status: 'loading' }),
        prepare: (query: Query) => ({ payload: query }),
      },
      succeeded: (
        _state,
        action: PayloadAction<PaginatedResult<T>>,
      ): AsyncState<PaginatedResult<T>> =>
        action.payload.items.length === 0
          ? { status: 'empty' }
          : { status: 'ready', data: action.payload },
      failed: (_state, action: PayloadAction<DataError>): AsyncState<PaginatedResult<T>> => ({
        status: 'error',
        error: action.payload,
      }),
      reset: (): AsyncState<PaginatedResult<T>> => ({ status: 'idle' }),
    },
  });

  return slice;
}
