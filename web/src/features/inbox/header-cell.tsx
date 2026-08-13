'use client';

import { createContext, useContext } from 'react';
import type { HeaderContext } from '@tanstack/react-table';
import { SortableHeader } from './sortable-header';
import { ColumnFilter, type FilterOption } from './column-filter';
import type { InboxColumn } from './columns';
import type { InboxFilters } from './use-inbox-query';
import type { ConversationRow } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐⭐ **THE HEADER CELL IS ONE STABLE COMPONENT, AND THAT IS THE FREEZE FIX.**
 *
 * `flexRender` (TanStack) does `React.createElement(header, ctx)` when `header` is a function — so an
 * INLINE ARROW passed as `header` is **a new component TYPE on every render**, and React answers a new
 * type by unmounting the old subtree and mounting a fresh one. With a Radix `Select` inside that
 * subtree, each remount registers its items and runs its Presence effects, each of those commits, the
 * commit produces new arrows, and the page runs a closed loop: measured on the live stand at ~3 500
 * commits per second, with `SelectItemProvider` / `SelectProvider` / `Presence` at the top of the
 * re-render tally and event listeners climbing past 16 000. The page answers for a few seconds, then
 * the next click wedges the renderer and it dies without a JS error.
 *
 * ⇒ **The rule: anything `flexRender` receives must be a stable reference.** Per-column data travels
 * in `columnDef.meta` (static, built once) and per-render data travels through this CONTEXT — so the
 * element type never changes, the Select is mounted once, and `INBOX_COLUMNS` can be memoised with no
 * dependencies at all.
 *
 * ⓘ Why no test caught it: jsdom has no ResizeObserver and no layout, and a remount loop that only
 * *reads* state renders identical HTML — every assertion about what the header shows passes while the
 * renderer burns. The browser check reads commit counts and listener counters instead.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface HeaderControls {
  readonly order: string;
  readonly onOrderChange: (order: string) => void;
  /** The status funnel's options — the account's catalogue narrowed to the CURRENT bucket. */
  readonly statusOptions: readonly FilterOption[];
  readonly filters: InboxFilters;
  readonly onFilterChange: (key: keyof InboxFilters, value: string | undefined) => void;
}

const NOOP_CONTROLS: HeaderControls = {
  order: '',
  onOrderChange: () => undefined,
  statusOptions: [],
  filters: {},
  onFilterChange: () => undefined,
};

const HeaderControlsContext = createContext<HeaderControls>(NOOP_CONTROLS);

export const HeaderControlsProvider = HeaderControlsContext.Provider;

/** What each column stashes for its header. Static — built once with the column definitions. */
export interface InboxColumnMeta {
  readonly tier: InboxColumn['tier'];
  readonly col: InboxColumn;
}

/** Static options resolve here; `'catalogue'` comes from the context, per bucket. */
function optionsFor(col: InboxColumn, controls: HeaderControls): readonly FilterOption[] {
  if (!col.filter) return [];
  if (col.filter.options === 'catalogue') return controls.statusOptions;
  return col.filter.options.map((v) => ({ value: v, label: v }));
}

export function InboxHeaderCell({ column }: HeaderContext<ConversationRow, unknown>) {
  const controls = useContext(HeaderControlsContext);
  const meta = column.columnDef.meta as InboxColumnMeta | undefined;
  const col = meta?.col;
  if (!col) return null;

  return (
    <span className="flex items-center gap-1">
      <SortableHeader column={col} order={controls.order} onOrderChange={controls.onOrderChange} />
      {col.filter && (
        <ColumnFilter
          header={col.header}
          filterKey={col.filter.key}
          options={optionsFor(col, controls)}
          value={controls.filters[col.filter.key]}
          onChange={(next) => controls.onFilterChange(col.filter!.key, next)}
        />
      )}
    </span>
  );
}

/**
 * The status column's labels (key → the account's agent-facing name), delivered by context for the
 * same reason the header controls are: the cell renderer must be a stable reference, so it cannot
 * close over per-render data. ⓘ A `cell` renderer goes through `flexRender` exactly like a header,
 * so the rule is identical — it is a component, and its type must not change.
 */
const StatusLabelsContext = createContext<Readonly<Record<string, string>>>({});

export const StatusLabelsProvider = StatusLabelsContext.Provider;

export function useStatusLabels(): Readonly<Record<string, string>> {
  return useContext(StatusLabelsContext);
}
