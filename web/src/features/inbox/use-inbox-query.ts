'use client';

import { useCallback, useMemo, useState } from 'react';
import { rowFor } from '@/data/gateway/registry';
import type { Query } from '@/data/types';
import { bucketById, DEFAULT_BUCKET, type BucketId } from './buckets';

/**
 * The Inbox's transient narrowing — filters, order and page cursor (feature 029, FR-013).
 *
 * ⚠️ **Transient is a requirement, not an omission.** Agents have no saved queries: anything named
 * and kept is a *view*, and views are granted by an admin (R11/R16). A "remember my last filter"
 * convenience would quietly create the user-owned view object the operator ruled out. Hence plain
 * component state and nothing written anywhere.
 */

/** The orders this route declares, in the order the control offers them. Never a literal here. */
export const INBOX_ORDERS = rowFor('conversations').orders ?? [];

/**
 * Human labels for the declared orders.
 *
 * ⚠️ Both say **"updated"**, and that is the honest word: the underlying column is `updated_at`
 * (research R7), which our own relabelling and resolving bump. "Last activity" would claim the
 * customer acted.
 *
 * ⛔ There is no third entry. Nothing computes urgency (roadmap 4.20 is unbuilt), and a "Recommended"
 * option would assert a property the data does not have — invisible to the agent trusting it.
 */
export const ORDER_LABELS: Readonly<Record<string, string>> = {
  updated_desc: 'Newest updated',
  updated_asc: 'Oldest updated',
};

export const DEFAULT_ORDER = 'updated_desc';

export interface InboxFilters {
  status?: string;
  channel?: string;
}

export interface InboxQueryState {
  filters: InboxFilters;
  order: string;
  bucket: BucketId;
  /** Pages accumulated so far; the cursor of the last one drives "load more". */
  cursor: string | null;
}

export interface UseInboxQuery {
  query: Query;
  filters: InboxFilters;
  order: string;
  bucket: BucketId;
  hasActiveFilters: boolean;
  setFilter: (key: keyof InboxFilters, value: string | undefined) => void;
  clearFilters: () => void;
  setOrder: (order: string) => void;
  setBucket: (bucket: BucketId) => void;
  loadMore: (cursor: string | null) => void;
}

const PAGE_SIZE = 50;

export function useInboxQuery(): UseInboxQuery {
  const [state, setState] = useState<InboxQueryState>({
    filters: {},
    order: DEFAULT_ORDER,
    bucket: DEFAULT_BUCKET,
    cursor: null,
  });

  /**
   * ⭐ Every narrowing change RESETS the cursor, and this is the whole reason these three live in one
   * state object rather than three `useState`s.
   *
   * A keyset cursor names a row *in a sequence*. Keep it across an order change and page two is drawn
   * from a different sequence than page one — rows repeated, rows missing, and no error anywhere. The
   * server refuses a token minted under another order (research R8), so the visible symptom would be
   * a sudden failure rather than corruption; this is what stops the person ever seeing it.
   *
   * The same applies to filters: a cursor from the unfiltered list means nothing in the filtered one.
   */
  const setFilter = useCallback((key: keyof InboxFilters, value: string | undefined) => {
    setState((prev) => {
      const filters = { ...prev.filters };
      if (value === undefined || value === '') delete filters[key];
      else filters[key] = value;
      return { ...prev, filters, cursor: null };
    });
  }, []);

  const clearFilters = useCallback(() => {
    setState((prev) => ({ ...prev, filters: {}, cursor: null }));
  }, []);

  const setOrder = useCallback((order: string) => {
    // Refused here as well as in the transport: an option that is not declared should never have been
    // rendered, so reaching this branch is a programming error rather than a user action.
    if (!INBOX_ORDERS.includes(order)) {
      throw new Error(`order "${order}" is not declared for conversations`);
    }
    setState((prev) => ({ ...prev, order, cursor: null }));
  }, []);

  /**
   * ⚠️ Switching bucket **clears the filters the bucket itself owns**.
   *
   * A bucket narrows by status; so does the status filter. Leaving both set gives two answers to one
   * question — pick "Resolved" while filtered to "pending" and the list is empty for a reason nothing
   * on screen explains. The bucket wins, and the filter it collides with is dropped rather than
   * silently overridden, so the filter bar shows the truth.
   */
  const setBucket = useCallback((bucket: BucketId) => {
    setState((prev) => {
      const owned = Object.keys(bucketById(bucket).filters) as (keyof InboxFilters)[];
      const filters = { ...prev.filters };
      for (const key of owned) delete filters[key];
      return { ...prev, bucket, filters, cursor: null };
    });
  }, []);

  const loadMore = useCallback((cursor: string | null) => {
    setState((prev) => ({ ...prev, cursor }));
  }, []);

  const query = useMemo<Query>(
    () => ({
      limit: PAGE_SIZE,
      order: state.order,
      cursor: state.cursor,
      // Only the keys the route declares reach the transport; an undeclared one is refused before a
      // request exists, which is why the filter bar can only ever set these two.
      // The bucket's narrowing goes first, so an explicit filter on a key the bucket does not own
      // still applies — and one it does own cannot be set at all (see `setBucket`).
      filters: { ...bucketById(state.bucket).filters, ...state.filters },
    }),
    [state],
  );

  return {
    query,
    filters: state.filters,
    order: state.order,
    bucket: state.bucket,
    hasActiveFilters: Object.keys(state.filters).length > 0,
    setFilter,
    clearFilters,
    setOrder,
    setBucket,
    loadMore,
  };
}
