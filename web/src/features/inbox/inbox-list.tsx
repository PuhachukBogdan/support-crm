'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/composites/data-table';
import { StatusBadge } from '@/components/composites/status-badge/status-badge';
import { INBOX_COLUMNS, type InboxColumn } from './columns';
import { ColumnFilter } from './column-filter';
import type { InboxFilters } from './use-inbox-query';

/** What a header needs to render its two controls. Passed down whole rather than as four props. */
interface HeaderControls {
  readonly order: string;
  readonly onOrderChange: (order: string) => void;
  readonly filters: InboxFilters;
  readonly onFilterChange: (key: keyof InboxFilters, value: string | undefined) => void;
}
import { relativeTime, statusFromWire } from './wire-labels';
import { SortableHeader } from './sortable-header';
import type { ConversationRow } from './types';
import type { AsyncState, PaginatedResult } from '@/data/types';

/**
 * The ticket list (feature 029, roadmap 9.2).
 *
 * Built on the shipped DataTable composite (8.5) — virtualization and the loading/empty/error
 * convention already live there and are not re-implemented.
 *
 * ⚠️ **`onSortChange` is deliberately NOT passed.** Handing it to DataTable turns every column header
 * into a sort button, including columns the server cannot order by (subject, channel, assignee). That
 * would offer orders nothing honours — the exact thing FR-012a forbids. Ordering is the explicit
 * two-option control instead, whose options come from the route registry.
 */

/** "Not set" as one string, used everywhere an empty value renders (FR-008). */
const NOT_SET = 'not set';

function EmptyValue({ label = NOT_SET }: { label?: string }) {
  // Never a blank cell: a blank reads as a loading failure. Never an invented default either.
  return <span className="text-muted-foreground">{label}</span>;
}

/** A time cell: relative, with the exact instant on hover (density spec — never lose the value). */
function TimeCell({ iso }: { iso: string }) {
  const shown = relativeTime(iso);
  if (!shown) return <EmptyValue />;
  const exact = new Date(iso);
  return (
    <span title={Number.isNaN(exact.getTime()) ? undefined : exact.toLocaleString()}>{shown}</span>
  );
}

/** How each declared column renders. Keyed by the same ids as the priority table. */
function cellFor(col: InboxColumn, controls: HeaderControls): ColumnDef<ConversationRow, unknown> {
  const base = {
    id: col.id,
    size: col.width,
    // The screen's whole narrowing statement. `DataTable` sheds by it — see `density-spec.md` §2/§7.
    meta: { tier: col.tier },
    /**
     * ⭐ The header carries BOTH of the column's controls — its sort and its own filter. Each renders
     * only where the thing behind it exists: a triangle only where the server declares that order, a
     * funnel only where the filter genuinely is this column.
     *
     * So `DataTable` needs no knowledge of either, and cannot turn every header into a control the
     * server would not honour.
     */
    header: () => (
      <span className="flex items-center gap-1">
        <SortableHeader column={col} order={controls.order} onOrderChange={controls.onOrderChange} />
        <ColumnFilter
          column={col}
          value={col.filter ? controls.filters[col.filter.key] : undefined}
          onChange={(next) => col.filter && controls.onFilterChange(col.filter.key, next)}
        />
      </span>
    ),
  };

  switch (col.id) {
    case 'subject':
      return {
        ...base,
        cell: ({ row }) =>
          row.original.subject ? (
            // Truncates rather than widening the table — the operator's «страница слишком растянута».
            <span className="block max-w-[42ch] truncate" title={row.original.subject}>
              {row.original.subject}
            </span>
          ) : (
            <EmptyValue label="no subject" />
          ),
      };
    case 'status':
      return {
        ...base,
        cell: ({ row }) => {
          // ⚠️ The wire sends `CONVERSATION_STATUS_OPEN`. Rendering it lowercased put
          // `conversation_status_open` in the column on the live stand — see `wire-labels.ts`.
          /**
           * ⚠️ `statusKey` FIRST. Feature 032 made the status a per-account key and marked the enum
           * field deprecated — the server stopped populating it, so this column read
           * `CONVERSATION_STATUS_UNSPECIFIED` and correctly rendered nothing. The operator's report was
           * exact: *"в solved тикеты без такого статуса"*.
           *
           * ⓘ What shows is the KEY (`solved`, `vip_pending`). The account's agent-facing NAME needs the
           * catalogue at `GET /conversations/statuses` joined client-side — 032 designed it that way, and
           * it is a separate step, not something to fake here from a key.
           */
          const status = row.original.statusKey?.trim() || statusFromWire(row.original.status);
          return status ? <StatusBadge kind="status" value={status} /> : <EmptyValue />;
        },
      };
    case 'priority':
      return {
        ...base,
        cell: ({ row }) =>
          row.original.priority ? (
            <StatusBadge kind="priority" value={row.original.priority.toLowerCase()} />
          ) : (
            <EmptyValue />
          ),
      };
    case 'playerId':
      // ⚠️ An identifier, and labelled as one — see columns.ts and research R9. The product holds no
      // customer name, so there is nothing here to mask and nothing to resolve.
      return {
        ...base,
        cell: ({ row }) =>
          row.original.playerId ? (
            <span className="font-mono text-xs">{row.original.playerId}</span>
          ) : (
            <EmptyValue label="not linked" />
          ),
      };
    case 'lastActivityAt':
      return { ...base, cell: ({ row }) => <TimeCell iso={row.original.lastActivityAt} /> };
    case 'createdAt':
      return { ...base, cell: ({ row }) => <TimeCell iso={row.original.createdAt} /> };
    case 'assigneeOperatorId':
      return {
        ...base,
        cell: ({ row }) =>
          row.original.assigneeOperatorId ? (
            <span className="font-mono text-xs">{row.original.assigneeOperatorId}</span>
          ) : (
            <EmptyValue label="unassigned" />
          ),
      };
    default:
      return {
        ...base,
        cell: ({ row }) => {
          const value = row.original[col.id];
          return value ? <span>{String(value)}</span> : <EmptyValue />;
        },
      };
  }
}

/**
 * ⛔ **`useViewportWidth` is gone.** It measured `window.innerWidth` and handed it to a breakpoint
 * function in this folder — the violation `density-spec.md` §7 records against feature 029, and wrong
 * twice over: the screen must not decide what fits (S2 does), and the window is not the table's width.
 * The composite measures its own box.
 */
export function InboxList({
  state,
  onLoadMore,
  onRetry,
  emptyLabel,
  rowSelection,
  order,
  onOrderChange,
  filters,
  onFilterChange,
}: {
  state: AsyncState<PaginatedResult<ConversationRow>>;
  onLoadMore?: () => void;
  onRetry?: () => void;
  emptyLabel: string;
  /** Omitted for anyone without a bulk action to perform — no checkboxes leading nowhere. */
  rowSelection?: { selected: string[]; onChange: (ids: string[]) => void };
  /** The order in force, so a sortable header can show which way it points. */
  order: string;
  onOrderChange: (order: string) => void;
  /** The filters in force — a header funnel renders the APPLIED value, never one it remembers itself. */
  filters: InboxFilters;
  onFilterChange: (key: keyof InboxFilters, value: string | undefined) => void;
}) {
  // Every declared column, every time. Which of them fits is the composite's answer, not this screen's.
  const columns = useMemo(
    () => INBOX_COLUMNS.map((col) => cellFor(col, { order, onOrderChange, filters, onFilterChange })),
    [order, onOrderChange, filters, onFilterChange],
  );

  return (
    <DataTable<ConversationRow>
      columns={columns}
      state={state}
      getRowId={(row) => row.id}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      emptyLabel={emptyLabel}
      rowSelection={rowSelection}
    />
  );
}
