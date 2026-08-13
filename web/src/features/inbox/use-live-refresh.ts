'use client';

import { useEffect } from 'react';
import { useDataAccess } from '@/data/provider';
import type { Query } from '@/data/types';

/**
 * Re-read the list when the server says something changed (feature 034, MVP block W4).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **NOTHING is merged from the event.** It carries a kind and one or two ids, so the only correct
 * reaction is to ask again through the same read path — which is where account scoping, RBAC, the AM's
 * portfolio narrowing, field tiers and the private-note filter all live. A screen that rendered the event
 * would be a second read path with none of those.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ⭐ Why it only refreshes on the FIRST page, and why that is not laziness ──────────────────────
 * `refetch` re-reads with `cursor: null`, and this list PAGES by appending. So refreshing while somebody
 * has paged deeper would replace an accumulated list with page one — the list jumping back to the top
 * under a person who is reading. `use-conversations.ts` already names that exact feeling as a defect worth
 * avoiding (*"it shows up as the list resetting to the top … which reads like a scroll glitch"*).
 *
 * Being slightly stale while somebody is deliberately deeper in a list is the better failure: they asked
 * for those rows, and the next filter change or manual refresh reconciles everything. ⚠️ **Recorded as a
 * limitation rather than hidden** — a live list that quietly stops being live below page one is exactly
 * the kind of thing that should be written down where the next reader will see it.
 *
 * ⓘ **Every kind refreshes, including `message.created`.** The Inbox shows last activity and orders by it,
 * so a new message changes the row — filtering by kind here would be a rule the list's own columns
 * contradict.
 */
export function useLiveRefresh(query: Query, refetch: () => void): void {
  const dataAccess = useDataAccess();
  const paged = query.cursor != null;

  useEffect(() => {
    // ⓘ `subscribe` always exists and always returns an unsubscribe — an implementation with no transport
    // returns a no-op, so this hook needs no capability check and cannot break a screen (FR-014).
    return dataAccess.subscribe(() => {
      if (paged) return;
      refetch();
    });
  }, [dataAccess, paged, refetch]);
}
