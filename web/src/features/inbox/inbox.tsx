'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { BulkActions, useMayExport } from './bulk-actions';
import { FilterBar } from './filter-bar';
import { InboxList } from './inbox-list';
import { BucketRail } from './bucket-rail';
import { SearchPlaceholder } from './coming-soon';
import { useInboxQuery } from './use-inbox-query';
import { useConversations } from './use-conversations';
import { useLiveRefresh } from './use-live-refresh';

/**
 * The Inbox — the agent's landing screen (feature 029, roadmap 9.2).
 *
 * Signing in puts a person here, looking at their own queue. There is no homepage: *«Зарегистрировался
 * менеджер, зашёл, открыл, всё. У него сразу же открыта вкладочка Inbox»* (R14/R15).
 *
 * ── What this screen deliberately does NOT have ──────────────────────────────────────────────────
 * ⛔ **A "Recommended" order.** Nothing computes urgency (roadmap 4.20 unbuilt), so the queue is not
 *    prioritised and does not claim to be.
 * ⛔ **Shared views.** No view entity, grant or count exists (roadmap 9.2a). And no placeholder for
 *    them either — an affordance for something that does not exist reads as a broken feature
 *    (FR-015b).
 * ⛔ **A requester name.** The product stores none (research R9).
 */
export function Inbox() {
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
  } = useInboxQuery();
  const list = useConversations(query);
  /**
   * Feature 034 (W4): a ticket that arrives by itself appears by itself. The event carries ids only and
   * nothing is merged from it — see the hook for why, and for why it holds off below page one.
   */
  useLiveRefresh(query, list.refetch);
  const [selected, setSelected] = useState<string[]>([]);
  // Row selection exists only where the actions it feeds do. An agent gets no checkboxes rather than
  // checkboxes that lead nowhere.
  const mayExport = useMayExport();

  /**
   * Three states, three different sentences (FR-003).
   *
   * ⚠️ "You have no tickets" and "nothing matches this filter" are different facts, and conflating
   * them is how an agent concludes there is no work when they have simply narrowed too far. The third
   * — failed to load — is the DataTable's error state and is already distinct.
   */
  const emptyLabel = hasActiveFilters
    ? 'No tickets match these filters.'
    : 'No tickets in your queue.';

  const nextCursor = list.status === 'ready' ? list.data.nextCursor : null;

  return (
    /**
     * ⭐ A full-height column: header and toolbar take what they need, the list takes the rest.
     *
     * ⚠️ This half of the fix matters as much as the composite's. The table can only fill a parent
     * that has a height to give — `space-y-4` on a plain block gave it none, so a table asked to fill
     * would collapse instead. The old 600 px box hid that: it looked deliberate at every size.
     */
    /**
     * ⭐ Two columns, as Zendesk's Home is arranged: the bucket rail, then the work surface.
     * `min-w-0` on the right column is what lets a wide table shrink instead of pushing the page.
     */
    <div className="flex h-full min-h-0 gap-6">
      <BucketRail value={bucket} onChange={setBucket} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <PageHeader title="Inbox" />

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          {/* Status and channel now live in their own column headers — see `column-filter.tsx`. */}
          <FilterBar hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
          {/* The shape of the search to come, labelled so nobody mistakes it for a working one. */}
          <SearchPlaceholder />
          {/**
           * ⛔ The sort DROPDOWN is gone (2026-08-03). With triangles on the `Updated` header it was a
           * second control for the same single action — and two controls for one thing are two places
           * to disagree. Zendesk has a dropdown on Home only because its list has no arrows; ours has
           * them, so the arrows win and the toolbar loses a row.
           */}
          <BulkActions selectedCount={selected.length} />
        </div>

        <InboxList
          state={list}
          emptyLabel={emptyLabel}
          onRetry={list.refetch}
          onLoadMore={nextCursor ? () => loadMore(nextCursor) : undefined}
          rowSelection={mayExport ? { selected, onChange: setSelected } : undefined}
          // Sorting AND filtering live on the column headers now — one control each, one place each.
          order={order}
          onOrderChange={setOrder}
          filters={filters}
          onFilterChange={setFilter}
        />
      </div>
    </div>
  );
}
