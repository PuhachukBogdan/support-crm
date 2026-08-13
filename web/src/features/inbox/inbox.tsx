'use client';

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { BulkActions, useMayExport } from './bulk-actions';
import { InboxToolbar } from './inbox-toolbar';
import { InboxList } from './inbox-list';
import { BucketRail } from './bucket-rail';
import { bucketById } from './buckets';
import { SearchPlaceholder } from './coming-soon';
import { useInboxQuery } from './use-inbox-query';
import { useConversations } from './use-conversations';
import { useLiveRefresh } from './use-live-refresh';
import { useMyOperator } from './use-my-operator';
import { useStatuses } from './use-statuses';

/**
 * The Inbox — the agent's landing screen (feature 029, roadmap 9.2; reshaped by W6 to R38).
 *
 * Signing in puts a person here, looking at the queue. *«Зарегистрировался менеджер, зашёл, открыл,
 * всё. У него сразу же открыта вкладочка Inbox»* (R14/R15).
 *
 * ── The W6 arrangement, and where each piece is decided ──────────────────────────────────────────
 * · the RAIL is R38's five buttons on **categories** (`bucket-rail.tsx` / `buckets.ts`);
 * · the TOOLBAR is the operator's praised Zendesk shape — Status ▾ from the account's own catalogue,
 *   channel chips, the «Мои» scope from 5.11 (`inbox-toolbar.tsx`);
 * · the status COLUMN shows the catalogue's agent names, falling back to the key (`use-statuses`).
 *
 * ── What this screen deliberately does NOT have ──────────────────────────────────────────────────
 * ⛔ **Numbers on the rail.** Counts are 9.2a's, the unread badge is 9.12's (R38: "no numbers").
 * ⛔ **Shared views.** No view entity, grant or count exists (roadmap 9.2a) — and no placeholder.
 * ⛔ **A requester name.** The product stores none (research R9).
 */
export function Inbox() {
  // "Which operator am I?" — resolves once; until it does, the «Мои» control stays disabled.
  const { operatorId } = useMyOperator();
  const { statuses } = useStatuses();
  const {
    query,
    filters,
    order,
    bucket,
    mine,
    hasActiveFilters,
    setFilter,
    clearFilters,
    setOrder,
    setBucket,
    setMine,
    loadMore,
  } = useInboxQuery(operatorId);
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

  // key → agent name, built once per catalogue arrival; the column renders words, stores keys.
  const statusLabels = useMemo(
    () => Object.fromEntries(statuses.map((s) => [s.key, s.agentName])),
    [statuses],
  );

  /**
   * Three states, three different sentences (FR-003).
   *
   * ⚠️ "You have no tickets" and "nothing matches this filter" are different facts, and conflating
   * them is how an agent concludes there is no work when they have simply narrowed too far. The third
   * — failed to load — is the DataTable's error state and is already distinct.
   */
  const emptyLabel = hasActiveFilters
    ? 'No tickets match these filters.'
    : 'No tickets in this bucket.';

  const nextCursor = list.status === 'ready' ? list.data.nextCursor : null;

  return (
    <div className="flex h-full min-h-0 gap-6">
      <BucketRail value={bucket} onChange={setBucket} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
        <PageHeader title="Inbox" />

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <InboxToolbar
            bucket={bucketById(bucket)}
            statuses={statuses}
            filters={filters}
            mine={mine}
            mineAvailable={operatorId !== undefined}
            hasActiveFilters={hasActiveFilters}
            onFilterChange={setFilter}
            onMineChange={setMine}
            onClear={clearFilters}
          />
          {/* The shape of the search to come, labelled so nobody mistakes it for a working one. */}
          <SearchPlaceholder />
          <BulkActions selectedCount={selected.length} />
        </div>

        <InboxList
          state={list}
          emptyLabel={emptyLabel}
          onRetry={list.refetch}
          onLoadMore={nextCursor ? () => loadMore(nextCursor) : undefined}
          rowSelection={mayExport ? { selected, onChange: setSelected } : undefined}
          order={order}
          onOrderChange={setOrder}
          statusLabels={statusLabels}
        />
      </div>
    </div>
  );
}
