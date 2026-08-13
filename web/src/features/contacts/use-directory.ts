'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, PaginatedResult } from '@/data/types';
import type { DirectoryRow } from './types';

/**
 * W11 — the directory's page read (roadmap 9.17).
 *
 * ⚠️ Its whole reason for existing beside `useList` is the HOLD: with no brand chosen there is no
 * question to ask, and `useList` has no way to skip. The alternative — passing a placeholder brand
 * so the hook has something to send — issues a real request for a brand that does not exist, which
 * later reads as a mysterious refusal in a log nobody can explain.
 *
 * Everything else is the shared shape: the same `AsyncState`, the same `DataError` classes, the
 * same transport (which refuses an undeclared filter before a request exists).
 */
export function useDirectory(
  brandId: string,
  playerIdPrefix: string,
): AsyncState<PaginatedResult<DirectoryRow>> & { refetch: () => void } {
  const dataAccess = useDataAccess();
  const [state, setState] = useState<AsyncState<PaginatedResult<DirectoryRow>>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!brandId) {
      // Waiting for the brand list, not empty and not broken — the screen shows its own skeleton.
      setState({ status: 'loading' });
      return;
    }
    let alive = true;
    setState({ status: 'loading' });
    void dataAccess
      .list<DirectoryRow>('players', {
        limit: 50,
        filters: { brandId, ...(playerIdPrefix ? { playerIdPrefix } : {}) },
      })
      .then((res) => {
        if (!alive) return;
        setState(res.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: res });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ status: 'error', error: toDataError(e) });
      });
    return () => {
      alive = false;
    };
  }, [dataAccess, brandId, playerIdPrefix, nonce]);

  return { ...state, refetch } as AsyncState<PaginatedResult<DirectoryRow>> & { refetch: () => void };
}
