'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { BulkActions, useMayExport } from './bulk-actions';
import { FilterBar } from './filter-bar';
import { InboxList } from './inbox-list';
import { BucketRail } from './bucket-rail';
import { bucketById } from './buckets';
import { SearchPlaceholder } from './coming-soon';
import { useInboxQuery } from './use-inbox-query';
import { useConversations } from './use-conversations';
import { useLiveRefresh } from './use-live-refresh';
import { useMyOperator } from './use-my-operator';
import { useStatuses } from './use-statuses';
import type { FilterOption } from './column-filter';
import type { AsyncState, PaginatedResult } from '@/data/types';
import type { ConversationRow } from './types';

/**
 * The Inbox — the agent's landing screen (feature 029, roadmap 9.2; reshaped by W6 to R38; corrected
 * on the operator's 2026-08-06 instructions).
 *
 * ── The arrangement, and where each piece is decided ─────────────────────────────────────────────
 * · the RAIL is R38's five buttons on **categories**, labelled in plain English (`buckets.ts`);
 * · filters are **funnels in the column headers** — status (from the account's own catalogue,
 *   narrowed to the bucket), channel, priority (`columns.ts` / `column-filter.tsx`). The W6 toolbar
 *   that briefly replaced them is gone: *«Мы зачем по-твоему их добавляли? Верни»*;
 * · ⭐⭐ the WHOLE SCREEN is scoped to the signed-in agent (`use-inbox-query`) — there is no toggle,
 *   and until `/me/operator` answers the screen shows its own loading/error, never everyone's queue.
 *
 * ── What this screen deliberately does NOT have ──────────────────────────────────────────────────
 * ⛔ **Numbers on the rail.** Counts are 9.2a's, the unread badge is 9.12's (R38: "no numbers").
 * ⛔ **Shared views.** No view entity, grant or count exists (roadmap 9.2a) — and no placeholder.
 * ⛔ **A requester name.** The product stores none (research R9).
 */
/**
 * ⚠️ TEMPORARY diagnostic switch for the freeze hunt (2026-08-06). `?probe=nolist` renders no table,
 * `?probe=nolive` skips the realtime subscription, `?probe=nostatuses` skips the catalogue fetch.
 * Removed the moment the cause is named — it exists because bisecting a minified production bundle by
 * rebuilds costs two minutes a step and this costs one deploy.
 */
function probeFlag(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('probe') ?? '';
}

export function Inbox() {
  const probe = probeFlag();
  // "Which operator am I?" — the scope the whole screen stands on (5.11).
  const me = useMyOperator();
  const { statuses: fetchedStatuses } = useStatuses();
  const statuses = probe === 'nostatuses' ? [] : fetchedStatuses;
  const {
    query,
    filters,
    order,
    bucket,
    hasActiveFilters,
    setFilter,
    clearFilters,
    setOrder,
    setBucket,
    loadMore,
  } = useInboxQuery(me.operatorId);
  const list = useConversations(query);
  /**
   * Feature 034 (W4): a ticket that arrives by itself appears by itself. The event carries ids only and
   * nothing is merged from it — see the hook for why, and for why it holds off below page one.
   */
  useLiveRefresh(probe === 'nolive' ? null : query, list.refetch);
  const [selected, setSelected] = useState<string[]>([]);
  // Row selection exists only where the actions it feeds do. An agent gets no checkboxes rather than
  // checkboxes that lead nowhere.
  const mayExport = useMayExport();

  // key → agent name, built once per catalogue arrival; the column renders words, stores keys.
  const statusLabels = useMemo(
    () => Object.fromEntries(statuses.map((s) => [s.key, s.agentName])),
    [statuses],
  );
  // The status funnel's options: ACTIVE statuses of THIS bucket's categories, by agent name — so a
  // retired status renders on old rows but cannot be asked for, and a contradiction is unbuildable.
  const statusOptions = useMemo<readonly FilterOption[]>(() => {
    const categories = bucketById(bucket).categories;
    return statuses
      .filter((s) => s.active && categories.includes(s.category))
      .map((s) => ({ value: s.key, label: s.agentName }));
  }, [statuses, bucket]);

  /**
   * ⚠️ The identity's own states ride the SAME table shell (which never unmounts its scroll element —
   * see DataTable's one-tree rule). While `/me/operator` is unresolved the list may not exist, so the
   * screen synthesizes the state instead of fetching: loading while we ask, an error with retry when
   * the answer failed — and never, in either case, somebody else's tickets.
   */
  const listState: AsyncState<PaginatedResult<ConversationRow>> & { refetch: () => void } =
    me.status === 'error'
      ? {
          status: 'error',
          error: { message: 'Could not resolve your operator profile.', retryable: true },
          refetch: me.retry,
        }
      : list;

  /**
   * Three states, three different sentences (FR-003). "You have no tickets" and "nothing matches
   * this filter" are different facts, and conflating them is how an agent concludes there is no work
   * when they have simply narrowed too far.
   */
  const emptyLabel = hasActiveFilters
    ? 'No tickets match these filters.'
    : 'No tickets in this bucket.';

  const nextCursor = listState.status === 'ready' ? listState.data.nextCursor : null;

  return (
    <div className="flex h-full min-h-0 gap-6">
      <BucketRail value={bucket} onChange={setBucket} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <PageHeader title="Inbox" />

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          {/* Status, channel and priority live in their own column headers — see `column-filter.tsx`. */}
          <FilterBar hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
          {/* The shape of the search to come, labelled so nobody mistakes it for a working one. */}
          <SearchPlaceholder />
          <BulkActions selectedCount={selected.length} />
        </div>

        {probe === 'nolist' ? (
          <div data-testid="probe-nolist" className="text-sm text-muted-foreground">
            probe=nolist — table not rendered ({listState.status})
          </div>
        ) : (
        <InboxList
          state={listState}
          emptyLabel={emptyLabel}
          onRetry={listState.refetch}
          onLoadMore={nextCursor ? () => loadMore(nextCursor) : undefined}
          rowSelection={mayExport ? { selected, onChange: setSelected } : undefined}
          order={order}
          onOrderChange={setOrder}
          statusLabels={statusLabels}
          statusOptions={statusOptions}
          filters={filters}
          onFilterChange={setFilter}
        />
        )}
      </div>
    </div>
  );
}
