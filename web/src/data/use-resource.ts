'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from './provider';
import { toDataError } from './errors';
import type { AsyncState, PaginatedResult, Query, ResourceName } from './types';

type ListState<T> = AsyncState<PaginatedResult<T>> & { refetch: () => void };

/**
 * US1 direct-call hook: reads a resource through the interface and exposes the shared
 * AsyncState (loading/error/empty/ready). Stale in-flight requests are ignored when the
 * query changes or the component unmounts. US2 adds the store-backed equivalent; both
 * expose the same AsyncState surface so consumers don't change.
 */
export function useList<T = unknown>(resource: ResourceName, query: Query): ListState<T> {
  const da = useDataAccess();
  const [state, setState] = useState<AsyncState<PaginatedResult<T>>>({ status: 'idle' });
  const key = JSON.stringify(query);

  const run = useCallback((): (() => void) => {
    let cancelled = false;
    setState({ status: 'loading' });
    da.list<T>(resource, query)
      .then((res) => {
        if (cancelled) return;
        setState(res.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: res });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ status: 'error', error: toDataError(e) });
      });
    return () => {
      cancelled = true;
    };
    // key is a stable stringification of `query`; da/resource complete the dependency set.
  }, [da, resource, key]);

  useEffect(() => run(), [run]);

  return { ...state, refetch: run } as ListState<T>;
}
