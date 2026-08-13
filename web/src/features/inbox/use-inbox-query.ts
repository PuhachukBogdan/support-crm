'use client';

import { useCallback, useMemo, useState } from 'react';
import { rowFor } from '@/data/gateway/registry';
import type { Query } from '@/data/types';
import { BUCKET_OWNED_KEYS, bucketById, DEFAULT_BUCKET, type BucketId } from './buckets';

/**
 * The Inbox's transient narrowing — bucket, filters, order and page cursor (feature 029 FR-013,
 * reshaped by W6/R38, self-scoped on the operator's instruction of 2026-08-06).
 *
 * ── ⭐⭐ THE WHOLE SCREEN IS SCOPED TO THE SIGNED-IN AGENT ─────────────────────────────────────────
 * *«Менеджеру и так только его тикеты приходят в инбокс и только его должны быть видны в open,
 * solved, pending»* — so `assigneeOperatorId = mine` rides EVERY request, in every bucket, and there
 * is no control to turn it off (the first cut shipped a «Мои» toggle; he asked why it exists and had
 * it removed). W5's routing is what makes this the right default: a channel ticket is assigned by
 * the drain, so "my tickets" is where new work actually arrives.
 *
 * ⚠️ **No operator id ⇒ NO REQUEST.** The query builder returns `null` until the id is known, and
 * the screen renders the identity's own loading/error instead of a list — because "my tickets"
 * silently widening to "all tickets" while identity resolves is the confidently-wrong-answer shape
 * (the 012 lesson), and it is also a DISCLOSURE: rows a person was never meant to scan.
 *
 * ⚠️ **What this hides, recorded rather than implied:** work assigned to NOBODY is visible to nobody
 * on this screen. Routed channels always assign (W5); a channel with no desk, or a desk with nobody
 * on shift, leaves tickets only the queue knows about. The supervisor surface over that is 4.20's
 * load-awareness view and 9.2a's views — not a hidden widening of an agent's inbox.
 *
 * ── Transience (FR-013) ──────────────────────────────────────────────────────────────────────────
 * Agents have no saved queries: anything named and kept is a *view*, and views are granted by an
 * admin (R11/R16). Plain component state, nothing written anywhere.
 */

/** The orders this route declares, in the order the control offers them. Never a literal here. */
export const INBOX_ORDERS = rowFor('conversations').orders ?? [];

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
  priority?: string;
  /** The bucket's categories. Owned by the bucket; a funnel never writes it. */
  statusCategories?: string;
}

export interface InboxQueryState {
  filters: InboxFilters;
  order: string;
  bucket: BucketId;
  /** Pages accumulated so far; the cursor of the last one drives "load more". */
  cursor: string | null;
}

export interface UseInboxQuery {
  /** `null` until the caller's operator id is known — no request may exist before the scope does. */
  query: Query | null;
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

/**
 * @param myOperatorId the caller's own operator id (`GET /me/operator`, roadmap 5.11), or undefined
 *        while unknown — in which case `query` is `null` and the screen must not fetch.
 */
export function useInboxQuery(myOperatorId: string | undefined): UseInboxQuery {
  const [state, setState] = useState<InboxQueryState>({
    filters: { ...bucketById(DEFAULT_BUCKET).filters },
    order: DEFAULT_ORDER,
    bucket: DEFAULT_BUCKET,
    cursor: null,
  });

  /**
   * ⭐ Every narrowing change RESETS the cursor — a keyset cursor names a row *in a sequence*, and a
   * cursor kept across a narrowing change resumes into a different sequence: rows repeated, rows
   * missing, no error anywhere (research R8).
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
    if (!INBOX_ORDERS.includes(order)) {
      throw new Error(`order "${order}" is not declared for conversations`);
    }
    setState((prev) => ({ ...prev, order, cursor: null }));
  }, []);

  /**
   * ⚠️ Switching bucket clears the filters that answer the bucket's own question (`BUCKET_OWNED_KEYS`):
   * a `vip_pending` carried into Solved would intersect to an empty page for a reason nothing on
   * screen explains. Channel and priority survive: different axes.
   */
  const setBucket = useCallback((bucket: BucketId) => {
    setState((prev) => {
      const filters = { ...prev.filters };
      for (const key of BUCKET_OWNED_KEYS) delete filters[key];
      return { ...prev, bucket, filters: { ...filters, ...bucketById(bucket).filters }, cursor: null };
    });
  }, []);

  const loadMore = useCallback((cursor: string | null) => {
    setState((prev) => ({ ...prev, cursor }));
  }, []);

  const query = useMemo<Query | null>(() => {
    // The scope IS the screen (see the header). Without it there is nothing safe to ask.
    if (!myOperatorId) return null;
    return {
      limit: PAGE_SIZE,
      order: state.order,
      cursor: state.cursor,
      filters: { ...state.filters, assigneeOperatorId: myOperatorId },
    };
  }, [state, myOperatorId]);

  return {
    query,
    filters: state.filters,
    order: state.order,
    bucket: state.bucket,
    // The bucket's own narrowing is where you ARE, not a filter you applied. The person's own
    // narrowings are exactly the funnel keys.
    hasActiveFilters:
      state.filters.status !== undefined ||
      state.filters.channel !== undefined ||
      state.filters.priority !== undefined,
    setFilter,
    clearFilters,
    setOrder,
    setBucket,
    loadMore,
  };
}
