'use client';

import { Filter } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The filter a column owns, opened from a **funnel in that column's own header** (operator,
 * 2026-08-03: *«может их прям в эту плашку и впихнуть»*; restored 2026-08-06 after W6's first cut
 * wrongly replaced it with a toolbar — *«Верни. И не делай так больше»*).
 *
 * ── Why the funnel IS the trigger ────────────────────────────────────────────────────────────────
 * The obvious build is a popover containing a dropdown, which nests one popup inside another: two
 * things to open, two to dismiss, two places focus can be trapped. One level does the whole job —
 * Radix's own `Select`, with the funnel as its trigger.
 *
 * ⚠️ **Radix, never a native `<select>`.** An OS dropdown popup froze the renderer at 100 % CPU on
 * this very screen, reproduced live — see `gotchas/headless-cannot-see-the-native-popup`.
 *
 * ── The header must not lie about what is applied ────────────────────────────────────────────────
 * ⭐ The trigger shows the **active option's label** and nothing when there is none. A funnel that
 * looks identical filtered and unfiltered is how an agent concludes the queue is empty while a
 * narrowing they forgot is still in force. Switching bucket clears the filter the bucket owns, and
 * this control shows that immediately, because it renders the applied value rather than remembering
 * its own.
 *
 * ⓘ Options arrive RESOLVED (value + label): the status column's come from the account's own
 * catalogue per bucket, so this control knows nothing about where words come from.
 */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export function ColumnFilter({
  header,
  filterKey,
  options,
  value,
  onChange,
}: {
  /** The column's human name, for the accessible label. */
  header: string;
  filterKey: string;
  options: readonly FilterOption[];
  /** The value in force, or `undefined`. Owned by the query state, never by this control. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  // A funnel with nothing to choose is a control that cannot act — render nothing (the Solved
  // bucket's status funnel, until the account configures a second solved-category status).
  if (options.length < 2 && value === undefined) return null;

  /**
   * ⚠️ Radix cannot carry an empty-string item value, so "no choice" needs a sentinel, mapped back to
   * `undefined` immediately — the query layer must never see it, because an undeclared filter value is
   * refused before a request exists.
   */
  const ANY = '__any__';
  const active = value !== undefined;
  const activeLabel = active ? (options.find((o) => o.value === value)?.label ?? value) : undefined;

  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? undefined : next)}
    >
      <SelectTrigger
        data-testid={`filter-${filterKey}`}
        // The accessible name says which column is being narrowed and whether it already is — a screen
        // reader user cannot see that the funnel is filled in.
        aria-label={active ? `Filter ${header}, ${activeLabel} applied` : `Filter ${header}`}
        className={cn(
          'h-6 gap-1 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-1',
          // ⓘ The S1 trigger always appends its own chevron. Hidden here rather than changed there: the
          // primitive is shared, and in a dense header a funnel already says "this opens a list".
          '[&>svg:last-child]:hidden',
          // A dense header: the control is icon-sized until something is applied, and only then does it
          // spend width on a word.
          active ? 'text-foreground' : 'w-6 justify-center text-muted-foreground',
        )}
      >
        <Filter className={cn('h-3.5 w-3.5 shrink-0', !active && 'opacity-50')} aria-hidden />
        {active && <span className="truncate">{activeLabel}</span>}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
