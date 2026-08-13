'use client';

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

/*
 * ⓘ `SearchPlaceholder` lived here until W24 (R43) made the box REAL — `inbox-search.tsx`, over
 * exactly the field the list shows (`[номер] тема`: number exact within THIS list's scope, subject
 * as a substring on the already-narrowed set). What the placeholder used to promise beyond that —
 * player, assignee, message text — remains W39's global screen, with its original constraint intact:
 * an INDEX, never a `LIKE` fanned across services.
 */
