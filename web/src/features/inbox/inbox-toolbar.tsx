'use client';

import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Bucket } from './buckets';
import type { InboxFilters } from './use-inbox-query';
import type { StatusDef } from './use-statuses';

/**
 * The toolbar above the list — Zendesk's own arrangement, which the operator praised verbatim on the
 * 08-04 snapshots: *«Отличная вещь — фильтры. Оставим»* (`screenshots/inbox/018…020`).
 *
 * ── What lives here, and where each decision comes from ──────────────────────────────────────────
 * · **Status ▾** — a dropdown listing the account's OWN statuses (018 shows Zendesk's: *Open, Pending,
 *   VIP Pending, In progress…*), by their agent names, narrowed to the current bucket's categories.
 *   Deriving the options from the catalogue is what makes a retired or renamed status unofferable —
 *   the `resolved` bucket served a 400 to every agent precisely because a screen spelled a key.
 * · **Channel chips** — `Все · API · Email` (R38: *"a chip row above the list"*, chips beating a
 *   bucket-per-channel because three kinds become five when 6.2/6.3 ship). ⚠️ No `messenger` chip:
 *   the kind exists in the vocabulary but no messenger is connected, and an option that can only
 *   ever match nothing teaches an agent the queue is empty (the standing empty-filter rule).
 *   ⓘ R38 wants the chip REMEMBERED per operator — that is a server-side preference and lands with
 *   W18's settings machinery; recorded in the plan, not dropped.
 * · **«Мои»** — the scope from 5.11: only conversations assigned to the signed-in agent. A SCOPE,
 *   not a filter: it survives bucket switches and "Clear filters" (see `use-inbox-query`), and it is
 *   DISABLED until the operator id arrives — "my tickets" silently meaning "all tickets" is the
 *   confidently-wrong-answer shape.
 * · **Clear filters** — renders only when something is applied (an always-present control that mostly
 *   does nothing is the affordance-without-a-feature defect this screen keeps removing).
 *
 * ⛔ **No sort dropdown**, although Zendesk's toolbar has one (020): ours lives on the column header
 * arrows, and two controls for one action are two places to disagree (decision of 2026-08-03, which
 * the operator has since seen and not reversed).
 */

const CHANNEL_CHIPS: readonly { value: string | undefined; label: string }[] = [
  { value: undefined, label: 'Все' },
  { value: 'api', label: 'API' },
  { value: 'email', label: 'Email' },
];

/** Radix cannot carry an empty-string item value; "no choice" is a sentinel mapped straight back. */
const ANY = '__any__';

export function InboxToolbar({
  bucket,
  statuses,
  filters,
  mine,
  mineAvailable,
  hasActiveFilters,
  onFilterChange,
  onMineChange,
  onClear,
}: {
  bucket: Bucket;
  statuses: readonly StatusDef[];
  filters: InboxFilters;
  mine: boolean;
  /** False until `GET /me/operator` answered — the scope control must not pretend. */
  mineAvailable: boolean;
  hasActiveFilters: boolean;
  onFilterChange: (key: keyof InboxFilters, value: string | undefined) => void;
  onMineChange: (mine: boolean) => void;
  onClear: () => void;
}) {
  /**
   * Only ACTIVE statuses of THIS bucket's categories are offered. A retired one still renders on old
   * rows (the column's job) but cannot be asked for — not settable, not offerable, still readable.
   */
  const options = statuses.filter((s) => s.active && bucket.categories.includes(s.category));
  const applied = filters.status;
  const appliedLabel = applied
    ? (statuses.find((s) => s.key === applied)?.agentName ?? applied)
    : undefined;

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="inbox-toolbar">
      {/* ── Status ▾ — hidden entirely when the bucket has one status or none: a dropdown offering
             a single option is a control that cannot choose. ─────────────────────────────────── */}
      {options.length > 1 && (
        <Select
          value={applied ?? ANY}
          onValueChange={(next) => onFilterChange('status', next === ANY ? undefined : next)}
        >
          <SelectTrigger
            data-testid="filter-status"
            aria-label={applied ? `Filter status, ${appliedLabel} applied` : 'Filter status'}
            className={cn(
              'h-8 w-auto gap-1.5 text-sm',
              applied ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <Filter className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
            {appliedLabel ?? 'Status'}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any</SelectItem>
            {options.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.agentName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* ── Channel chips (R38) ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1" role="group" aria-label="Channel">
        {CHANNEL_CHIPS.map((chip) => {
          const active = filters.channel === chip.value || (!filters.channel && !chip.value);
          return (
            <button
              key={chip.label}
              type="button"
              data-testid={`chip-channel-${chip.value ?? 'all'}`}
              aria-pressed={active}
              onClick={() => onFilterChange('channel', chip.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* ── «Мои» — the 5.11 scope ──────────────────────────────────────────────────────────── */}
      <button
        type="button"
        data-testid="scope-mine"
        aria-pressed={mine}
        disabled={!mineAvailable}
        // The title says WHY it is disabled — a dead control with no explanation reads as broken.
        title={mineAvailable ? undefined : 'Определяем ваш профиль оператора…'}
        onClick={() => onMineChange(!mine)}
        className={cn(
          'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
          mine
            ? 'border-foreground bg-foreground text-background'
            : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          !mineAvailable && 'cursor-not-allowed opacity-50',
        )}
      >
        Мои
      </button>

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" data-testid="filter-clear" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
