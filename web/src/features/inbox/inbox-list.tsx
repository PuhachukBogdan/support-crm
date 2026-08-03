'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/composites/data-table';
import { StatusBadge } from '@/components/composites/status-badge/status-badge';
import { columnsForWidth, type InboxColumn } from './columns';
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
function cellFor(
  col: InboxColumn,
  sorting: { order: string; onOrderChange: (order: string) => void },
): ColumnDef<ConversationRow, unknown> {
  const base = {
    id: col.id,
    size: col.minWidth,
    // The header renders the triangles itself when the column is sortable, so `DataTable` needs no
    // sorting knowledge — and cannot turn every header into a control the server would not honour.
    header: () => (
      <SortableHeader column={col} order={sorting.order} onOrderChange={sorting.onOrderChange} />
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
          const status = statusFromWire(row.original.status);
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
 * Which columns fit. Measured, because the requirement is about the viewport and jsdom has no layout
 * — so the rule is asserted on `columnsForWidth` directly and the measurement is what Track B checks
 * in a real browser (quickstart B6).
 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 2560 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export function InboxList({
  state,
  onLoadMore,
  onRetry,
  emptyLabel,
  rowSelection,
  order,
  onOrderChange,
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
}) {
  const width = useViewportWidth();
  const columns = useMemo(
    () => columnsForWidth(width).map((col) => cellFor(col, { order, onOrderChange })),
    [width, order, onOrderChange],
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
