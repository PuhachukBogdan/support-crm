'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '@/store';
import { conversationsActions } from '@/store/conversations/conversations.slice';
import type { AsyncState, PaginatedResult, Query } from '@/data/types';
import type { ConversationRow } from './types';

export type ConversationsList = AsyncState<PaginatedResult<ConversationRow>> & {
  refetch: () => void;
};

/**
 * Binds the transient query (filters + order + cursor) to the store (feature 029).
 *
 * ⚠️ The cursor decides WHICH action fires: a query with no cursor is a fresh `load` (replaces), one
 * with a cursor is a `loadMore` (appends). Getting this backwards is not a visible bug on page one —
 * it shows up as the list resetting to the top when someone asks for more, which reads like a scroll
 * glitch rather than a wrong action.
 */
export function useConversations(query: Query): ConversationsList {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.conversations);

  // A stable stringification: using the object itself would re-fire every render (new identity).
  const key = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const q = queryRef.current;
    dispatch(q.cursor ? conversationsActions.loadMore(q) : conversationsActions.load(q));
  }, [dispatch, key]);

  const refetch = useMemo(
    () => () => dispatch(conversationsActions.load({ ...queryRef.current, cursor: null })),
    [dispatch],
  );

  return { ...state, refetch };
}
