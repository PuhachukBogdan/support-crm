'use client';

import { useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../index';
import { recordsActions } from '../records/records.slice';
import type { AsyncState, PaginatedResult, Query } from '@/data/types';
import type { DemoRecord } from '@/data/mock/demo-data';

type ListResult<T> = AsyncState<PaginatedResult<T>> & { refetch: () => void };

/**
 * Store-backed list hook (US2). Same AsyncState surface as the US1 direct hook, so a screen
 * swaps from one to the other without changing its rendering. Dispatches `load` on mount /
 * query change; `takeLatest` in the saga cancels superseded requests.
 */
export function useRecords(query: Query): ListResult<DemoRecord> {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.records);
  const key = JSON.stringify(query);

  useEffect(() => {
    // `key` is a stable stringification of `query` — using the object itself would loop
    // (new identity each render). Load on mount and whenever the query value changes.
    dispatch(recordsActions.load(query));
  }, [dispatch, key]);

  const refetch = useMemo(() => () => dispatch(recordsActions.load(query)), [dispatch, key]);

  return { ...state, refetch };
}
