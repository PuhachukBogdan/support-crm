'use client';

import { useCallback, useMemo, useState } from 'react';
import { rowFor } from '@/data/gateway/registry';
import type { Query } from '@/data/types';
import { BUCKET_OWNED_KEYS, bucketById, DEFAULT_BUCKET, type BucketId } from './buckets';

/**
 * The Inbox's transient narrowing — bucket, filters, scope, order and page cursor (feature 029
 * FR-013, reshaped by W6/R38).
 *
 * ⚠️ **Transient is a requirement, not an omission.** Agents have no saved queries: anything named
 * and kept is a *view*, and views are granted by an admin (R11/R16). A "remember my last filter"
 * convenience would quietly create the user-owned view object the operator ruled out. Hence plain
 * component state and nothing written anywhere. (R38 asks for the channel chip to be REMEMBERED per
 * operator — that is a server-side preference, and it lands with W18, the settings block, where the
 * preference read/write machinery is built once for the theme and this rides it. Recorded in the
 * plan, not silently dropped.)
 */

/** The orders this route declares, in the order the control offers them. Never a literal here. */
export const INBOX_ORDERS = rowFor('conversations').orders ?? [];

/**
 * Human labels for the declared orders.
 *
 * ⚠️ Both time orders say **"updated"**, and that is the honest word: the underlying column is
 * `updated_at` (research R7), which our own relabelling and resolving bump. "Last activity" would
 * claim the customer acted.
 *
 * ⚠️ The third is **"Most urgent"**, not Zendesk's "Recommended": the server sorts by a stated key —
 * priority rank first, longest wait within it — and nothing recommends anything. "Recommended" would
 * promise a judgement no code makes, which is the 029 refusal by another name.
 */
export const ORDER_LABELS: Readonly<Record<string, string>> = {
  updated_desc: 'Newest updated',
  updated_asc: 'Oldest updated',
  urgency_desc: 'Most urgent',
};

export const DEFAULT_ORDER = 'updated_desc';

export interface InboxFilters {
  /** An exact status KEY within the bucket — offered only from the account's own catalogue. */
  status?: string;
  channel?: string;
  /** The bucket's categories. Owned by the bucket; a screen control never writes it directly. */
  statusCategories?: string;
}

export interface InboxQueryState {
  filters: InboxFilters;
  order: string;
  bucket: BucketId;
  /**
   * ⭐ W6 — the «Мои» SCOPE: only conversations assigned to the signed-in agent. A separate axis
   * from the filters ("which state" vs "whose"), deliberately outside `hasActiveFilters` and outside
   * "Clear filters": clearing your narrowings must not silently widen you back onto everybody
   * else's queue.
   */
  mine: boolean;
  /** Pages accumulated so far; the cursor of the last one drives "load more". */
  cursor: string | null;
}

export interface UseInboxQuery {
  query: Query;
  filters: InboxFilters;
  order: string;
  bucket: BucketId;
  mine: boolean;
  hasActiveFilters: boolean;
  setFilter: (key: keyof InboxFilters, value: string | undefined) => void;
  clearFilters: () => void;
  setOrder: (order: string) => void;
  setBucket: (bucket: BucketId) => void;
  setMine: (mine: boolean) => void;
  loadMore: (cursor: string | null) => void;
}

const PAGE_SIZE = 50;

/**
 * @param myOperatorId the caller's own operator id (`GET /me/operator`, roadmap 5.11), or undefined
 *        while unknown. ⚠️ With it unknown the «Мои» scope contributes NOTHING to the query — the
 *        control that sets `mine` must stay disabled until the id arrives, because "my tickets"
 *        silently meaning "all tickets" is the confidently-wrong-answer shape (the 012 lesson).
 */
export function useInboxQuery(myOperatorId?: string): UseInboxQuery {
  const [state, setState] = useState<InboxQueryState>({
    filters: { ...bucketById(DEFAULT_BUCKET).filters },
    order: DEFAULT_ORDER,
    bucket: DEFAULT_BUCKET,
    mine: false,
    cursor: null,
  });

  /**
   * ⭐ Every narrowing change RESETS the cursor, and this is the whole reason these live in one
   * state object rather than separate `useState`s.
   *
   * A keyset cursor names a row *in a sequence*. Keep it across an order change and page two is drawn
   * from a different sequence than page one — rows repeated, rows missing, and no error anywhere. The
   * server refuses a token minted under another order (research R8), so the visible symptom would be
   * a sudden failure rather than corruption; this is what stops the person ever seeing it.
   */
  const setFilter = useCallback((key: keyof InboxFilters, value: string | undefined) => {
    setState((prev) => {
      const filters = { ...prev.filters };
      if (value === undefined || value === '') delete filters[key];
      else filters[key] = value;
      return { ...prev, filters, cursor: null };
    });
  }, []);

  /** Clears the person's OWN narrowings. The bucket's categories stay — the bucket is where you are. */
  const clearFilters = useCallback(() => {
    setState((prev) => ({
      ...prev,
      filters: { ...bucketById(prev.bucket).filters },
      cursor: null,
    }));
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
   * ⚠️ Switching bucket clears the filters that answer the bucket's own question (`BUCKET_OWNED_KEYS`):
   * the categories it sets, and any exact status key picked inside the previous bucket — a `vip_pending`
   * carried into Solved would intersect to an empty page for a reason nothing on screen explains.
   * Channel and the «Мои» scope survive: different axes.
   */
  const setBucket = useCallback((bucket: BucketId) => {
    setState((prev) => {
      const filters = { ...prev.filters };
      for (const key of BUCKET_OWNED_KEYS) delete filters[key];
      return { ...prev, bucket, filters: { ...filters, ...bucketById(bucket).filters }, cursor: null };
    });
  }, []);

  const setMine = useCallback((mine: boolean) => {
    setState((prev) => ({ ...prev, mine, cursor: null }));
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
      // request exists. The scope contributes only when BOTH halves are true — see the param note.
      filters: {
        ...state.filters,
        ...(state.mine && myOperatorId ? { assigneeOperatorId: myOperatorId } : {}),
      },
    }),
    [state, myOperatorId],
  );

  return {
    query,
    filters: state.filters,
    order: state.order,
    bucket: state.bucket,
    mine: state.mine,
    // The bucket's own narrowing is where you ARE, not a filter you applied — it must not light up
    // "Clear filters", and the empty state stays "no tickets" rather than "nothing matches". The
    // person's own narrowings are exactly `status` and `channel`.
    hasActiveFilters: state.filters.status !== undefined || state.filters.channel !== undefined,
    setFilter,
    clearFilters,
    setOrder,
    setBucket,
    setMine,
    loadMore,
  };
}
