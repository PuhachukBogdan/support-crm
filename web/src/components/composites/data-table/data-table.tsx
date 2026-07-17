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
import { EmptyState, ErrorState, LoadingRows } from '@/components/composites/states';
import type { AsyncState, PaginatedResult, Query } from '@/data/types';

const ROW_HEIGHT = 44;

export type DataTableProps<T> = {
  columns: ColumnDef<T, unknown>[];
  state: AsyncState<PaginatedResult<T>>;
  getRowId: (row: T) => string;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onSortChange?: (sort: NonNullable<Query['sort']>) => void;
  rowSelection?: { selected: string[]; onChange: (ids: string[]) => void };
  emptyLabel?: string;
  /** Scroll-viewport height; virtualization keeps rendered rows proportional to it. */
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
  height = 600,
}: DataTableProps<T>) {
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
    initialRect: { width: 0, height },
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
  if (state.status === 'empty') {
    return (
      <div data-testid="dt-empty">
        <EmptyState title={emptyLabel} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={parentRef}
        data-testid="dt-scroll"
        className="overflow-auto overscroll-contain rounded-md border border-border"
        style={{ maxHeight: height }}
      >
        <Table>
          <TableHeader className="sticky top-0 z-sticky bg-card">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
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
                <TableRow key={row.id} data-index={vi.index} data-selected={row.getIsSelected()}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
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
