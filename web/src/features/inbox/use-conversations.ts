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
/**
 * @param query `null` = DO NOT FETCH — the caller's scope is not established yet (W6: the Inbox is
 *        self-scoped, and a request without the scope would list other people's tickets). The hook
 *        then reports `loading`, because that is what the screen is doing: waiting to be allowed to
 *        ask.
 */
export function useConversations(query: Query | null): ConversationsList {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((s: RootState) => s.conversations);

  // A stable stringification: using the object itself would re-fire every render (new identity).
  const key = query === null ? '' : JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const q = queryRef.current;
    if (q === null) return;
    dispatch(q.cursor ? conversationsActions.loadMore(q) : conversationsActions.load(q));
  }, [dispatch, key]);

  const refetch = useMemo(
    () => () => {
      const q = queryRef.current;
      if (q === null) return;
      dispatch(conversationsActions.load({ ...q, cursor: null }));
    },
    [dispatch],
  );

  if (query === null) return { status: 'loading', refetch };
  return { ...state, refetch };
}
