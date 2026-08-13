'use client';

import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/composites/data-table';
import { StatusBadge } from '@/components/composites/status-badge/status-badge';
import { INBOX_COLUMNS, type InboxColumn } from './columns';
import type { FilterOption } from './column-filter';
import type { InboxFilters } from './use-inbox-query';
import {
  HeaderControlsProvider,
  InboxHeaderCell,
  StatusLabelsProvider,
  useStatusLabels,
  type HeaderControls,
  type InboxColumnMeta,
} from './header-cell';
import { relativeTime, statusFromWire } from './wire-labels';
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

/**
 * How each declared column renders — **built ONCE, with no per-render data** (see `header-cell.tsx`
 * for why: a header whose component type changes per render remounts a Radix Select on every commit).
 * Everything dynamic reaches the header and the status cell through context.
 */
function cellFor(col: InboxColumn): ColumnDef<ConversationRow, unknown> {
  const meta: InboxColumnMeta = { tier: col.tier, col };
  const base = {
    id: col.id,
    size: col.width,
    // The screen's whole narrowing statement (`DataTable` sheds by `tier`) plus the column itself,
    // which the stable header component reads instead of closing over it.
    meta,
    /**
     * ⭐⭐ A STABLE component reference, never an inline arrow — the freeze fix. It carries both of the
     * column's controls (its sort and its own funnel), each rendering only where the thing behind it
     * exists. See `header-cell.tsx` for the measurement that made this mandatory.
     */
    header: InboxHeaderCell,
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
          if (!status) return <EmptyValue />;
          // ⓘ A `cell` renderer IS a component (flexRender calls createElement on it), so a hook
          // here is legal — and the reason it must read context rather than close over the labels is
          // the same one `header-cell.tsx` documents at length.
          const labels = useStatusLabels();
          /**
           * ⭐ W6: the catalogue join 032 designed — the account's agent-facing NAME when the
           * catalogue has arrived, the key as an honest fallback when it has not (or when an old row
           * wears a key the catalogue no longer lists; a retired status must still render).
           */
          return <StatusBadge kind="status" value={labels[status] ?? status} />;
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
  statusLabels = {},
  statusOptions = [],
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
  /** key → agent-facing name from the account's catalogue; the status cell falls back to the key. */
  statusLabels?: Readonly<Record<string, string>>;
  /** The status funnel's options: the catalogue narrowed to the current bucket's categories. */
  statusOptions?: readonly FilterOption[];
  /** The filters in force — a funnel renders the APPLIED value, never one it remembers itself. */
  filters: InboxFilters;
  onFilterChange: (key: keyof InboxFilters, value: string | undefined) => void;
}) {
  /**
   * ⭐ Built ONCE, with no dependencies: the definitions carry no per-render data, so their identity
   * never changes and TanStack never re-creates the header subtree. Which of them fits is the
   * composite's answer, not this screen's.
   */
  const columns = useMemo(() => INBOX_COLUMNS.map((col) => cellFor(col)), []);

  // One object per render is fine — it is a PROP, not a component type (see `header-cell.tsx`).
  const controls: HeaderControls = { order, onOrderChange, statusOptions, filters, onFilterChange };

  // ⚠️ TEMPORARY (2026-08-06 freeze hunt): `?probe=rawrows` renders the same rows and the same funnels
  // WITHOUT the DataTable composite, to separate the composite from everything else on this screen.
  const probe =
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('probe') ?? '';
  if (probe === 'rawrows') {
    const rows = state.status === 'ready' ? state.data.items : [];
    return (
      <HeaderControlsProvider value={controls}>
        <StatusLabelsProvider value={statusLabels}>
          <div data-testid="probe-rawrows" className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  {INBOX_COLUMNS.map((c) => (
                    <th key={c.id} className="text-left text-xs">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-index={r.id}>
                    <td className="text-xs">{r.statusKey}</td>
                    <td className="text-xs">{r.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StatusLabelsProvider>
      </HeaderControlsProvider>
    );
  }

  return (
    <HeaderControlsProvider value={controls}>
      <StatusLabelsProvider value={statusLabels}>
    <DataTable<ConversationRow>
      columns={columns}
      state={state}
      getRowId={(row) => row.id}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      emptyLabel={emptyLabel}
      rowSelection={rowSelection}
    />
      </StatusLabelsProvider>
    </HeaderControlsProvider>
  );
}
