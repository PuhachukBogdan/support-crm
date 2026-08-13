'use client';

import { Filter } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { InboxColumn } from './columns';

/**
 * The filter a column owns, opened from a **funnel in that column's own header** (operator,
 * 2026-08-03: *«может их прям в эту плашку и впихнуть»*).
 *
 * ── Why the funnel IS the trigger ────────────────────────────────────────────────────────────────
 * The obvious build is a popover containing the toolbar's old `Choice` dropdown, which nests one popup
 * inside another: two things to open, two to dismiss, two places focus can be trapped. One level does
 * the whole job — Radix's own `Select`, with the funnel as its trigger. (`choice.tsx` was that toolbar
 * control and is deleted with this change: nothing else used it.)
 *
 * ⚠️ **Radix, never a native `<select>`.** An OS dropdown popup froze the renderer at 100 % CPU on this
 * very screen, reproduced live: the identical change made programmatically never froze, the same change
 * through the real popup froze every time. Radix renders its list into the page, so there is no native
 * widget to be mid-close during a commit. The move off native selects was itself that bug's fix — see
 * `specs/029-inbox/` and the vault's `gotchas/headless-cannot-see-the-native-popup`.
 *
 * ── The header must not lie about what is applied ────────────────────────────────────────────────
 * ⭐ The trigger shows the **active value** and nothing when there is none. A funnel that looks
 * identical filtered and unfiltered is how an agent concludes the queue is empty while a narrowing they
 * forgot is still in force — the same class of defect as a filter whose every option matches nothing.
 * Switching bucket clears the filter the bucket owns, and this control shows that immediately, because
 * it renders the applied value rather than remembering its own.
 */
export function ColumnFilter({
  column,
  value,
  onChange,
}: {
  column: InboxColumn;
  /** The value in force, or `undefined`. Owned by the query state, never by this control. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  if (!column.filter) return null;

  /**
   * ⚠️ Radix cannot carry an empty-string item value, so "no choice" needs a sentinel, mapped back to
   * `undefined` immediately — the query layer must never see it, because an undeclared filter value is
   * refused before a request exists.
   */
  const ANY = '__any__';
  const active = value !== undefined;

  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? undefined : next)}
    >
      <SelectTrigger
        data-testid={`filter-${column.filter.key}`}
        // The accessible name says which column is being narrowed and whether it already is — a screen
        // reader user cannot see that the funnel is filled in.
        aria-label={
          active ? `Filter ${column.header}, ${value} applied` : `Filter ${column.header}`
        }
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
        {active && <span className="truncate">{value}</span>}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any</SelectItem>
        {column.filter.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
