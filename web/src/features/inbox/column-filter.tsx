'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 * control owns its own popup: one button, one list positioned by hand, no presence machinery, no
 * collection registration — nothing that can schedule work while the table re-renders.
 * It is the only kind of dropdown this table may host.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐⭐ **2026-08-10 — the list is now PORTALLED, and the note above no longer says "no portal".**
 *
 * The operator, on the shipped Inbox: *«я нажимаю на воронку, и я вижу маленькую часть этого
 * элемента, но она скрыта, она на какой-то слой ниже… за окном перечисления самих тикетов»*.
 *
 * ⚠️ It was never a z-index problem, which is why `z-popover` did not save it. `DataTable` renders
 * every header cell as `<TableHead className="truncate">`, and `truncate` is `overflow: hidden` —
 * so the popup was CLIPPED to a ~40 px cell box. No stacking value can escape an ancestor's clip;
 * only leaving that ancestor can. (The scroll container's own `overflow-auto` clips it too, one
 * level further out.) That is also exactly why the operator saw *a small part* of it rather than
 * nothing: the sliver that fitted inside the cell.
 *
 * ⇒ The list renders into `document.body` and positions itself from the trigger's measured rect.
 *
 * ⚠️ **This does NOT reintroduce what froze the page.** The freeze was never caused by portalling as
 * such — it was presence machinery, focus scopes and collection registration re-registering while a
 * virtualized header re-rendered, all of which posted scheduler work at rest. `createPortal` is a
 * DOM relocation and nothing else: no state, no subscription, no work when closed. The two
 * listeners below exist ONLY while the list is open and do nothing but re-measure.
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
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  /** Where the portalled list sits, in viewport coordinates. `null` until measured. */
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  /**
   * Measure from the TRIGGER, every time. The list is `position: fixed`, so these are viewport
   * coordinates and no ancestor's transform or scroll offset enters the arithmetic.
   *
   * ⚠️ Flips above the trigger when the space below cannot hold it. A funnel in the last column of a
   * short viewport would otherwise open into a list whose options are off-screen — the same defect
   * as the clip, arriving through the bottom edge instead.
   */
  const place = useCallback(() => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const GAP = 4;
    const MIN = 160;
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    const openUp = below < MIN && above > below;
    // Clamped so a funnel near the right edge does not push its list past the viewport.
    const width = listRef.current?.offsetWidth ?? 192;
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - width - GAP));
    setBox({
      left,
      top: openUp ? Math.max(GAP, r.top - GAP) : r.bottom + GAP,
      maxHeight: Math.max(MIN, Math.min(288, openUp ? above : below)),
    });
  }, []);

  // Measured before paint, so the list never appears at 0,0 and jump to place.
  useLayoutEffect(() => {
    if (open) place();
    else setBox(null);
  }, [open, place]);

  /**
   * Close on an outside click or Escape; re-measure on scroll and resize. All four listeners exist
   * ONLY while the list is open — nothing runs when it is closed, which is the property the freeze
   * history above makes non-negotiable.
   *
   * ⓘ `scroll` is captured so the table's own scroll container reaches this too (a scroll event does
   * not bubble). Re-measuring rather than closing: the header is sticky, so the trigger stays put
   * vertically and closing on every wheel tick would be its own annoyance.
   */
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // BOTH boxes: the list is a portal now, so it is no longer inside the trigger's subtree, and
      // testing only the trigger would close the popup on the very click that chooses an option.
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

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

      {open &&
        createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${header} filter`}
          data-testid={`filter-${filterKey}-list`}
          // ⓘ `fixed`, in `document.body`: outside every `overflow: hidden` between here and the page,
          // which is the whole fix. `z-popover` still names the layer it belongs to.
          style={
            box
              ? { left: box.left, top: box.top, maxHeight: box.maxHeight }
              : // Off-screen for the one frame before the layout effect measures — never at 0,0,
                // where it would flash in the corner of the page.
                { left: -9999, top: -9999 }
          }
          className="fixed z-popover min-w-[12rem] overflow-auto rounded-md border border-border bg-card p-1 shadow-md"
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
        </ul>,
          document.body,
        )}
    </span>
  );
}
