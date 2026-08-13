'use client';

import { useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
// ⓘ `EmptyState` is deliberately not used here any more: an empty result keeps the table and puts the
// message in a row, as Zendesk does. The centred composite still serves screens that are not tables.
import { ErrorState, LoadingRows } from '@/components/composites/states';
import type { AsyncState, PaginatedResult, Query } from '@/data/types';

/**
 * The row height, and the ONE number the virtualizer and the DOM have to agree on.
 *
 * ⚠️ **The estimate is not a hint — it is the coordinate system.** `estimateSize` is never corrected
 * by measurement here (deliberately: see `INITIAL_RECT` below), so every pixel of disagreement between
 * this number and the row a browser actually lays out accumulates once per row. It shipped disagreeing:
 * a `p-2` cell around a `text-sm` line plus the `border-b` measures ~37 px, so the model ran ~7 px per
 * row ahead of reality — invisible at the top of the list and a couple of hundred pixels out by the
 * middle. The operator saw exactly what that arithmetic predicts: *«скролл поддёргивает и дрожит и
 * стоит на месте»* — part of the travel opened no new rows, because the model believed in content that
 * was not there.
 *
 * So the row is **pinned** rather than the estimate guessed. Deriving the estimate from the real height
 * instead would put font metrics, badge padding and the density scale into the virtualizer's
 * coordinate system, where any theme change silently reintroduces the drift.
 *
 * ⚠️ These two constants are one fact written twice. `data-table.test.tsx` fails if they drift.
 */
const ROW_HEIGHT = 44;
/** Tailwind's `h-11` = 2.75rem = 44 px, on the 0.25rem spacing scale the test re-derives. */
export const ROW_HEIGHT_CLASS = 'h-11';
export { ROW_HEIGHT };

/**
 * First-paint guess for the scroll viewport, before it is measured.
 *
 * ⚠️ A module constant on purpose: it used to be an object literal built inside the render, so every
 * render handed the virtualizer a fresh `initialRect`. That is a re-measure invitation on a component
 * whose measurement loop is the one thing that must not be provoked.
 */
const INITIAL_RECT = { width: 0, height: 600 } as const;

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  state: AsyncState<PaginatedResult<T>>;
  getRowId: (row: T) => string;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onSortChange?: (sort: NonNullable<Query['sort']>) => void;
  rowSelection?: { selected: string[]; onChange: (ids: string[]) => void };
  emptyLabel?: string;
  /**
   * Scroll-viewport height in pixels.
   *
   * ⚠️ **Optional, and normally omitted.** Left unset — the default — the table **fills the height its
   * parent gives it**, which is what a work surface must do. It used to default to `600`, so the Inbox
   * shipped as a 600-pixel box: fine on an old laptop, half an empty page on the operator's 2K monitor.
   * *«Не надо хардкодить по пикселям»* — `ui-design/density-spec.md` §0.
   *
   * Pass a number only for a table genuinely embedded in a fixed slot (a card, a preview).
   */
  height?: number;
};

/**
 * The workhorse list composite (S2). Virtualized (bounded row nodes at ~372K rows),
 * keyset-paginated (loadMore, never offset), server-driven sort/select. Renders the shared
 * loading/empty/error states. Styled only via the S1 Table primitive + tokens (no hex).
 */
export function DataTable<T>({
  columns,
  state,
  getRowId,
  onLoadMore,
  onRetry,
  onSortChange,
  rowSelection,
  emptyLabel = 'Nothing here yet.',
  height,
}: DataTableProps<T>) {
  /** Fills its parent unless a caller pinned a height. See the prop's note. */
  const fills = height === undefined;
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const items = state.status === 'ready' ? state.data.items : [];

  const selected = rowSelection?.selected ?? [];
  const rowSelectionState: RowSelectionState = useMemo(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected],
  );

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!rowSelection) return columns;
    const selectCol: ColumnDef<T, unknown> = {
      id: '__select',
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all"
          checked={table.getIsAllRowsSelected()}
          onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select row ${row.id}`}
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(!!v)}
        />
      ),
      size: 40,
    };
    return [selectCol, ...columns];
  }, [columns, rowSelection]);

  const table = useReactTable({
    data: items,
    columns: allColumns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    state: { rowSelection: rowSelectionState },
    enableRowSelection: !!rowSelection,
    onRowSelectionChange: (updater) => {
      if (!rowSelection) return;
      const next = typeof updater === 'function' ? updater(rowSelectionState) : updater;
      rowSelection.onChange(Object.keys(next).filter((k) => next[k]));
    },
  });

  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // A first-paint guess only; the real size is measured from the scroll element. Kept constant so
    // the options object does not hand the virtualizer a new rect on every render.
    initialRect: INITIAL_RECT,
  });
  const vItems = virtualizer.getVirtualItems();
  const paddingTop = vItems.length > 0 ? vItems[0]!.start : 0;
  const paddingBottom =
    vItems.length > 0 ? virtualizer.getTotalSize() - vItems[vItems.length - 1]!.end : 0;
  const colCount = allColumns.length;

  function cycleSort(field: string) {
    const dir = sortDir === 'asc' ? 'desc' : 'asc';
    setSortDir(dir);
    onSortChange?.([{ field, dir }]);
  }

  // Non-ready states render the shared states/ composites (single source of truth).
  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div data-testid="dt-loading">
        <LoadingRows />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div data-testid="dt-error">
        <ErrorState error={state.error} onRetry={onRetry} />
      </div>
    );
  }
  /**
   * ⚠️ **Empty no longer replaces the table**, and that is both a copy of Zendesk and a bug fix.
   *
   * `screenshots/views_1.png` keeps the column headers and puts *"No tickets in this view"* in a row
   * beneath them — so a person can see what they filtered by and undo it. Ours replaced the entire
   * table with a centred message, which meant every transition to an empty result **tore down the
   * whole table**: hundreds of nodes removed in one commit, in the same commit as a `<select>`'s
   * value change. That is the shape that froze the renderer once already, and the operator hit it
   * again on the one filter that always returns nothing.
   *
   * Keeping the header mounted removes the teardown *and* answers the question the empty screen
   * should answer: empty **of what**.
   */
  if (state.status === 'empty') {
    return (
      <div className={cn('flex flex-col gap-3', fills && 'min-h-0 flex-1')} data-testid="dt-empty">
        <div
          className={cn(
            'overflow-auto rounded-md border border-border',
            fills && 'min-h-0 flex-1',
          )}
        >
          <Table>
            <TableHeader className="sticky top-0 z-sticky bg-card">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell colSpan={colCount} className="py-8 text-center text-muted-foreground">
                  {emptyLabel}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-3', fills && 'min-h-0 flex-1')}>
      <div
        ref={parentRef}
        data-testid="dt-scroll"
        className={cn(
          // ⚠️ `overflow-anchor:none` is load-bearing, not tidying. Scroll anchoring picks a node in
          // view and preserves ITS position when the DOM around it changes — a good default, and the
          // wrong one here, because virtualization removes the node it anchored to as a matter of
          // course. Each unmount then lets the browser correct `scrollTop` underneath the virtualizer,
          // which recomputes the range from the corrected value: the shake the operator reported.
          'overflow-auto overscroll-contain [overflow-anchor:none] rounded-md border border-border',
          // Filling: take the remaining height of the column. Pinned: cap at the given number.
          fills && 'min-h-0 flex-1',
        )}
        style={fills ? undefined : { maxHeight: height }}
      >
        {/**
         * ⚠️ **`table-fixed` is part of the row-height contract, not styling.**
         *
         * `columns.ts` states the rule — when width runs out, low-priority columns are dropped and the
         * rest TRUNCATE, never scroll sideways. Only the subject cell implemented it, so every other
         * cell **wrapped** once squeezed, and a wrapped cell is a row taller than {@link ROW_HEIGHT}.
         * That is the same drift the pinned height fixes, arriving through width instead of content:
         * fine maximised, visible at half screen, which is exactly how it was reported.
         *
         * Auto layout would size columns to content, so forbidding the wrap would push the table wider
         * instead — trading a jitter for the sideways scroll the same rule forbids. Fixed layout makes
         * the declared widths authoritative, so a cell can only clip.
         */}
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-sticky bg-card">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className="truncate">
                    {header.isPlaceholder ? null : onSortChange && header.column.id !== '__select' ? (
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => cycleSort(header.column.id)}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {paddingTop > 0 && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: paddingTop }} />
              </tr>
            )}
            {vItems.map((vi) => {
              const row = rows[vi.index]!;
              return (
                <TableRow
                  key={row.id}
                  // Pinned so the row a browser lays out is the row the virtualizer budgeted for.
                  className={ROW_HEIGHT_CLASS}
                  data-index={vi.index}
                  data-selected={row.getIsSelected()}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      // Single line, clipped — so no cell can make the row taller than the pin.
                      // ⓘ Not on the checkbox column: `overflow-hidden` there clips its focus ring,
                      // and a checkbox has nothing to truncate anyway.
                      className={cell.column.id === '__select' ? undefined : 'truncate'}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden>
                <td colSpan={colCount} style={{ height: paddingBottom }} />
              </tr>
            )}
          </TableBody>
        </Table>
      </div>

      {state.data.hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
