'use client';

import { Button } from '@/components/ui/button';
import { Choice } from './choice';
import type { InboxFilters } from './use-inbox-query';

/**
 * Transient filters: status and channel (feature 029, FR-011/FR-013).
 *
 * ⚠️ **Nothing here is saved.** No localStorage, no preference call, no URL round-trip. Agents have
 * no saved queries by the operator's decision (R11/R16) — anything named and kept is a *view*, and
 * views are granted by an admin. A "remember my last filter" convenience would quietly create the
 * user-owned object he ruled out.
 */

/**
 * ⚠️ Statuses are DATA, not code (cross-cutting conclusion D — custom statuses exist). These are the
 * ones the wire enum defines **and that something actually produces**; when custom statuses land they
 * come from the server and this constant goes away.
 *
 * ⛔ **`snoozed` was here and is removed.** The operator hit it and asked what it was for — the honest
 * answer is *nothing*: it exists in the schema comment and both wire maps, **no code path ever sets
 * it**, and the stand has zero such rows (open 19 · pending 9 · resolved 7). It was in this list only
 * because I copied the enum instead of asking what fills it.
 *
 * That is precisely the defect already rejected for `category` in this feature — *"a filter whose
 * every option matches nothing is worse than no filter"* — committed here by the person who wrote
 * that sentence. A filter option that can only ever return an empty list teaches an agent that the
 * queue is empty when it is not.
 *
 * ⛔ **`resolved` is also gone**, on the operator's instruction (2026-08-03): it has its own bucket in
 * the rail, and *«не вижу смысла отдельно в статус фильтре resolved выделять, если они будут в
 * отдельной вкладке»*. Two routes to the same set is how a bucket and a filter end up disagreeing —
 * the collision this screen already has to resolve in `setBucket`.
 */
const STATUSES = ['open', 'pending'] as const;

/**
 * ⚠️ **The channel list is deliberately NOT a closed catalogue.** A channel is data, never a branch
 * (roadmap 9.6a) — Phase 6 adds them as connections are made. These are the values present today; the
 * gateway accepts any well-formed name, so a new channel becomes filterable without a code change.
 *
 * ⛔ **There is no "no channel" option, and that is a real limitation worth stating.** About one in
 * six conversations carry no channel; the wire cannot express "unset" as a filter value (an empty
 * string means "no filter"). Those rows stay reachable by not filtering — so the filter narrows, and
 * clearing it is how you get back to everything (FR-011a).
 */
const CHANNELS = ['chat', 'email', 'api'] as const;

export function FilterBar({
  filters,
  hasActiveFilters,
  onChange,
  onClear,
}: {
  filters: InboxFilters;
  hasActiveFilters: boolean;
  onChange: (key: keyof InboxFilters, value: string | undefined) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="inbox-filters">
      <Choice
        label="Status"
        testId="filter-status"
        value={filters.status}
        onChange={(v) => onChange('status', v)}
        options={STATUSES}
      />
      <Choice
        label="Channel"
        testId="filter-channel"
        value={filters.channel}
        onChange={(v) => onChange('channel', v)}
        options={CHANNELS}
      />

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" data-testid="filter-clear" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
