'use client';

import { Button } from '@/components/ui/button';

/**
 * What is left of the filter toolbar (feature 029 FR-011/FR-013, narrowed by roadmap 9.2b).
 *
 * ⭐ **Status and channel moved into their own column headers** — `columns.ts` declares each filter on
 * the column it narrows, and `column-filter.tsx` renders the funnel. Their option lists moved with
 * them, comments and all: the reasoning about *which* statuses exist belongs beside the column that
 * offers them, not beside a bar that no longer does.
 *
 * ⚠️ **Nothing here is saved.** No localStorage, no preference call, no URL round-trip. Agents have no
 * saved queries by the operator's decision (R11/R16) — anything named and kept is a *view*, and views
 * are granted by an admin. A "remember my last filter" convenience would quietly create the user-owned
 * object he ruled out.
 */
export function FilterBar({
  hasActiveFilters,
  onClear,
}: {
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="inbox-filters">
      {/**
       * ⚠️ **The bar could not simply be deleted, and 9.2b says why:** folding filters into the header
       * works only where the filter *is* a column, so the bar cannot disappear until every offered
       * filter has a home there. Today both do — status and channel — leaving exactly one thing that
       * belongs to no single column: undoing all of them at once.
       *
       * ⛔ It renders nothing when nothing is applied. An always-present "Clear filters" is a control
       * that does nothing most of the time, which is the affordance-without-a-feature defect this
       * screen keeps removing.
       */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" data-testid="filter-clear" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
