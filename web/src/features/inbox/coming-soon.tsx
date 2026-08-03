'use client';

import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Placeholders for two things the operator asked to see the shape of before they exist
 * (2026-08-03): *«можешь пока визуальные пустышки сделать чтоб не забыли и прописать coming soon»*.
 *
 * ── ⚠️ This reverses FR-015b, and the reversal is narrow on purpose ─────────────────────────────
 * That requirement says the screen must show **no placeholder** where a missing feature will go,
 * because *"an affordance for something that does not exist reads as a broken feature"*. It was
 * written about the views panel and it is still right about anything that looks operable.
 *
 * What makes these acceptable is the same thing that makes R13's reserved telephony slot acceptable:
 * ⭐ **they say what they are.** A greyed-out search box that swallows keystrokes lies; one labelled
 * "coming soon", not focusable, and visibly inert does not. The rule being protected is *never let a
 * person believe a control works*, not *never show a shape*.
 *
 * ⇒ Any placeholder here must be **`aria-hidden`, non-focusable and non-interactive**, so assistive
 * tech does not announce a control either.
 */
export function ComingSoonBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground',
        className,
      )}
    >
      soon
    </span>
  );
}

/**
 * The search the operator wants across ticket fields — player id, subject, assignee, category.
 *
 * ⚠️ **Two of those are ordinary filters that already exist** (`playerId`, `assigneeOperatorId`), and
 * one — **subject** — needs full-text search the product does not have. That is roadmap **9.13**, and
 * it carries a binding constraint: an **index**, never a `LIKE` fanned across services, because the
 * fan-out is impossible under DB-per-service and would not survive ~3 000 tickets/day. So this shape
 * is here to be seen, not to be wired up cheaply.
 */
export function SearchPlaceholder() {
  return (
    <div
      data-testid="search-coming-soon"
      // Inert by construction: not a button, not an input, not focusable, not announced.
      aria-hidden
      className="flex h-9 min-w-0 flex-1 cursor-default select-none items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground"
    >
      <Search className="h-4 w-4 shrink-0 opacity-60" />
      <span className="truncate">Search tickets — by player, subject, assignee…</span>
      <ComingSoonBadge className="ml-auto" />
    </div>
  );
}
