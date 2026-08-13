'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
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
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⛔⛔ **THE VIRTUALIZER IS GONE, and that is the freeze fix — measured, not reasoned.**
 *
 * The operator froze this page three times in three shapes. Bisected on the live stand with a probe
 * switch built into one deploy (`?probe=…`), reading React's own scheduler:
 *
 *   · at rest, React posts NOTHING;
 *   · one bucket click and it posts **~9 000 times a second, for ever** — the page answers for a few
 *     seconds, then the next click wedges the renderer and it dies with no JS error;
 *   · `?probe=nolist` (everything except the table): **2 posts.** So it is the table;
 *   · `?probe=nolive`, `?probe=nostatuses`: still ~9 000/s. Not realtime, not the catalogue;
 *   · ResizeObserver callbacks: **zero** — so it is not the width/measurement loop earlier fixes
 *     chased, and removing Radix Select from the header did not stop it either.
 *
 * `virtual-core`'s `_willUpdate` runs in a layout effect on EVERY render and re-subscribes whenever
 * `getScrollElement()` differs from what it holds, notifying as it goes; a notify is a React update,
 * and a React update is another render. That is the engine of the loop, and it is one this screen
 * never needed: **the list is keyset-paginated at 50 rows.** 50 DOM rows want no virtualization —
 * "bounded row nodes at 372K rows" was a property of a list nothing renders.
 *
 * ⇒ Rows render directly. The trade-off, stated rather than buried: with many "Load more" clicks the
 * DOM grows linearly (20 pages = 1 000 rows), which browsers handle comfortably; if a screen ever
 * genuinely needs to render tens of thousands of rows at once, virtualization comes back **with a
 * scroll element held in state** (so its subscription cannot re-run per render) and a live-browser
 * commit-rate assertion beside it — jsdom cannot see any of this.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The three tiers of `ui-design/density-spec.md` §2 — the mechanism that makes §1 hold ("a ticket list
 * must fit a 2K screen without horizontal scrolling").
 *
 * ⚠️ **A screen declares a tier and nothing else; this composite decides what fits** (§7: S2 owns
 * tiering, S4 declares tiers). Feature 029 broke both halves — `features/inbox/columns.ts` invented
 * numeric priorities 1–6 with per-column breakpoints and the screen measured `window.innerWidth`
 * itself — and the spec records the cause plainly: *the file was never opened*.
 *
 * ⓘ A column with no declared tier is `essential`, so every existing caller keeps rendering every
 * column exactly as before.
 */
export type ColumnTier = 'essential' | 'contextual' | 'optional';

/** Declared on `ColumnDef.meta`, which is TanStack's own extension point — not a parallel array. */
declare module '@tanstack/react-table' {
  // The two parameters are TanStack's own; they are unused here and must keep their names/arity.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    tier?: ColumnTier;
  }
}

/** Lowest first — the order columns are shed in. `essential` is absent because it is never shed. */
const SHED_ORDER: readonly ColumnTier[] = ['optional', 'contextual'];

export function tierOf<T>(col: ColumnDef<T, unknown>): ColumnTier {
  return col.meta?.tier ?? 'essential';
}

/** TanStack's declared width for a column; the fallback matches its own default. */
function sizeOf<T>(col: ColumnDef<T, unknown>): number {
  return typeof col.size === 'number' ? col.size : 150;
}

/**
 * Which columns fit `available` px.
 *
 * `optional` starts **off** (§2: "off by default; opted into per user"), then `contextual` columns are
 * shed **from the last declared backwards** until the declared widths fit. `essential` columns are never
 * shed — at an absurd width they truncate instead, which they now do by construction
 * ({@link ROW_HEIGHT_CLASS} and `table-fixed`).
 *
 * ⚠️ `available <= 0` means *not measured yet*, not *no room*. Reading it as no room would shed every
 * sheddable column on the first paint and then add them back — a visible reflow on every mount.
 */
export function columnsThatFit<T>(
  columns: ColumnDef<T, unknown>[],
  available: number,
  optedIn: readonly string[] = [],
): ColumnDef<T, unknown>[] {
  const kept = columns.filter(
    (c) => tierOf(c) !== 'optional' || (c.id !== undefined && optedIn.includes(c.id)),
  );
  if (available <= 0) return kept;

  const total = () => kept.reduce((sum, c) => sum + sizeOf(c), 0);
  for (const tier of SHED_ORDER) {
    for (let i = kept.length - 1; i >= 0 && total() > available; i--) {
      if (tierOf(kept[i]!) === tier) kept.splice(i, 1);
    }
  }
  return kept;
}

/**
 * The composite's own width, measured. ⭐ **Its own** — the screen used to measure `window.innerWidth`,
 * from which the sidebar, the bucket rail and every gap still have to be subtracted, so it decided about
 * a table far wider than the one it has. That is why columns were squeezed at half screen at all.
 */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    // jsdom ships no ResizeObserver; a one-shot read still gives tests a deterministic width.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

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
  /**
   * Ids of `optional`-tier columns the person has opted into (§2: "off by default; opted into per user,
   * and remembered"). ⓘ The *remembering* is a preference, not a table concern — this prop is where it
   * arrives. Omitted ⇒ no optional column renders.
   */
  optionalColumns?: readonly string[];
};

/** Stable identity so an omitted `optionalColumns` cannot invalidate the memo on every render. */
const NO_OPTIONAL: readonly string[] = [];
/** Same rule for row selection — see the note at its use. */
const NO_SELECTION: readonly string[] = [];

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
  optionalColumns = NO_OPTIONAL,
}: DataTableProps<T>) {
  /** Fills its parent unless a caller pinned a height. See the prop's note. */
  const fills = height === undefined;
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const items = state.status === 'ready' ? state.data.items : [];

  /**
   * ⚠️ `NO_SELECTION` is a module constant, not `?? []`. A fresh `[]` per render made the memo below
   * recompute every render, so `state.rowSelection` reached TanStack as a NEW OBJECT on every render —
   * one link in the "new identity per render" chain that fed the table's own state machinery. Every
   * such link is a candidate for the commit storm this file's big note describes.
   */
  const selected = rowSelection?.selected ?? NO_SELECTION;
  const rowSelectionState: RowSelectionState = useMemo(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected],
  );

  /** Measured here, never handed in: see {@link useMeasuredWidth}. */
  const rootRef = useRef<HTMLDivElement>(null);
  const measuredWidth = useMeasuredWidth(rootRef);
  const fitting = useMemo(
    () => columnsThatFit(columns, measuredWidth, optionalColumns),
    [columns, measuredWidth, optionalColumns],
  );

  // Keyed on WHETHER selection exists, never on the prop object's identity — callers build that object
  // inline, so depending on it would rebuild the column set (and the row model) on every render.
  const selectable = !!rowSelection;
  const onSelectionChange = rowSelection?.onChange;
  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return fitting;
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
    return [selectCol, ...fitting];
  }, [fitting, selectable]);

  const table = useReactTable({
    data: items,
    columns: allColumns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    state: { rowSelection: rowSelectionState },
    enableRowSelection: !!rowSelection,
    onRowSelectionChange: (updater) => {
      if (!onSelectionChange) return;
      const next = typeof updater === 'function' ? updater(rowSelectionState) : updater;
      onSelectionChange(Object.keys(next).filter((k) => next[k]));
    },
  });

  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement>(null);
  const colCount = allColumns.length;

  function cycleSort(field: string) {
    const dir = sortDir === 'asc' ? 'desc' : 'asc';
    setSortDir(dir);
    onSortChange?.([{ field, dir }]);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠️⚠️ **ONE TREE FOR ALL FOUR STATES — the scroll container is NEVER unmounted.** This paragraph
   * replaces three early returns, and the reason is the worst defect this screen has had.
   *
   * The virtualizer above holds `getScrollElement: () => parentRef.current` for the whole life of
   * the component. The early returns for loading / error / empty rendered trees WITHOUT `parentRef`,
   * so every transition through them detached the virtualizer's element while the instance lived on —
   * and TanStack Virtual then re-ran its setup against a vanishing target on every scheduler tick.
   * Measured on the live stand (2026-08-06, CDP `Memory.getDOMCounters`): **~40 leaked JS event
   * listeners per bucket switch** (each switch passes through `loading`), and on a SUSTAINED empty
   * result a continuous re-render loop churning **~6 000 listeners per second** — the page still
   * answers for a while, then the next click wedges the renderer and it dies without a JS error.
   * That is the freeze the operator has now hit three times in three shapes («страница зависла», the
   * filter-switch freeze, «в ждут с email на мои»): the previous fixes each removed a TRIGGER (the
   * reconnect loop, the full-table teardown); this removes the mechanism.
   *
   * ⇒ THE RULE, for every screen with a virtualizer or an observer: **the element a long-lived
   * instance watches must live exactly as long as the instance.** States render INSIDE the body —
   * a skeleton row set, an error row, an empty row (which is also Zendesk's own shape: headers stay,
   * the message sits beneath them, so the screen still answers *empty of what*).
   * ⓘ jsdom ships no ResizeObserver, which is why no unit test ever saw any of this; the browser
   * check now walks an empty transition and reads the listener counters.
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const status =
    state.status === 'idle' ? 'loading' : (state.status as 'loading' | 'error' | 'empty' | 'ready');

  return (
    <div ref={rootRef} className={cn('flex flex-col gap-3', fills && 'min-h-0 flex-1')}>
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
            {status === 'loading' && (
              <TableRow data-testid="dt-loading">
                <TableCell colSpan={colCount} className="p-4">
                  <LoadingRows />
                </TableCell>
              </TableRow>
            )}
            {status === 'error' && state.status === 'error' && (
              <TableRow data-testid="dt-error">
                <TableCell colSpan={colCount} className="p-4">
                  <ErrorState error={state.error} onRetry={onRetry} />
                </TableCell>
              </TableRow>
            )}
            {status === 'empty' && (
              <TableRow data-testid="dt-empty">
                <TableCell colSpan={colCount} className="py-8 text-center text-muted-foreground">
                  {emptyLabel}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, index) => {
              return (
                <TableRow
                  key={row.id}
                  // Pinned so the row a browser lays out is the row the virtualizer budgeted for.
                  className={ROW_HEIGHT_CLASS}
                  data-index={index}
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
          </TableBody>
        </Table>
      </div>

      {state.status === 'ready' && state.data.hasMore && onLoadMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
