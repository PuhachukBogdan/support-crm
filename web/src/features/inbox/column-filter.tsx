'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Filter } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The filter a column owns, opened from a **funnel in that column's own header** (operator,
 * 2026-08-03: *«может их прям в эту плашку и впихнуть»*; restored 2026-08-06 — *«Верни. И не делай
 * так больше»*).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **NO RADIX SELECT HERE, AND NO NATIVE `<select>` EITHER — both froze this screen.**
 *
 * History, because it is the whole reason this file is hand-written:
 *  · a native `<select>` froze the renderer at 100 % CPU (feature 029; the OS popup is mid-close while
 *    React commits — `gotchas/headless-cannot-see-the-native-popup`);
 *  · Radix `Select` replaced it, and on 2026-08-06 the operator froze the page THREE times. Measured on
 *    the live stand: at rest the React scheduler posts NOTHING; one bucket click and it posts ~2 300
 *    times a second for ever, with `SelectItemProvider` / `SelectProvider` / `Presence` filling the
 *    re-render tally, listeners climbing past 16 000, and the renderer dying on the next click with no
 *    JS error. ResizeObserver fires zero times, so it is not a measurement loop; making the header's
 *    component type stable (`header-cell.tsx`) did not stop it either.
 *
 * ⇒ A dropdown inside a virtualized, re-rendering table header is where both libraries broke, so this
 * control owns its own popup: one button, one absolutely-positioned list, no portal, no presence
 * machinery, no collection registration — nothing that can schedule work while the table re-renders.
 * It is ~40 lines and it is the only kind of dropdown this table may host.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── The header must not lie about what is applied ────────────────────────────────────────────────
 * ⭐ The trigger shows the **active option's label** and nothing when there is none. A funnel that
 * looks identical filtered and unfiltered is how an agent concludes the queue is empty while a
 * narrowing they forgot is still in force.
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listId = useId();

  // Close on an outside click or Escape. One listener pair, only while open — nothing runs when the
  // popup is closed, which is the whole point of not using a library here.
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // A funnel with nothing to choose is a control that cannot act (the Solved bucket's status funnel,
  // until an account configures a second solved-category status).
  if (options.length < 2 && value === undefined) return null;

  const active = value !== undefined;
  const activeLabel = active ? (options.find((o) => o.value === value)?.label ?? value) : undefined;

  const choose = (next: string | undefined) => {
    setOpen(false);
    onChange(next);
  };

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        data-testid={`filter-${filterKey}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // The accessible name says which column is narrowed and whether it already is — a screen
        // reader user cannot see that the funnel is filled in.
        aria-label={active ? `Filter ${header}, ${activeLabel} applied` : `Filter ${header}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded px-1 text-xs hover:bg-accent',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <Filter className={cn('h-3.5 w-3.5 shrink-0', !active && 'opacity-50')} aria-hidden />
        {active && <span className="max-w-[12ch] truncate">{activeLabel}</span>}
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${header} filter`}
          // ⓘ In-flow absolute positioning, not a portal: a portal is what needs presence machinery,
          // focus scopes and collection registration — the things that made the library versions loop.
          // `z-popover` is the token; the sticky header sits on `z-sticky` below it.
          className="absolute left-0 top-full z-popover mt-1 max-h-72 min-w-[12rem] overflow-auto rounded-md border border-border bg-card p-1 shadow-md"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!active}
              onClick={() => choose(undefined)}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              Any
            </button>
          </li>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => choose(option.value)}
                className={cn(
                  'block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                  option.value === value && 'font-medium',
                )}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
