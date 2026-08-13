'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { BackButton } from './back';

/**
 * The top bar, after W22 (R40/R44).
 *
 * ── What LEFT this bar, and where each went ──────────────────────────────────────────────────────
 * · **Theme** → account settings. *«Не забудьте вынести смену темы из главного меню в настройки,
 *   потому что в главном меню её быть не должно.»*
 * · **Sign-out** → account settings. *«Разлогиниться можно, но в этом особого смысла нет, потому что
 *   никто logout часто делать не будет.»* ⚠️ The property it carries — a sign-out ends the session on
 *   the SERVER — travelled with it and is asserted where it now lives.
 * · **The rail toggle** → deleted outright. The rail no longer expands (R41), so there is nothing to
 *   toggle.
 *
 * ── What ARRIVED ────────────────────────────────────────────────────────────────────────────────
 * **Back** (R44), on the left, so every screen has a way out of itself. It renders only when there
 * IS a previous screen — see `back.tsx` for why that is not a disabled button.
 *
 * ── ⏳ And what the bar is now WAITING for, deliberately empty ────────────────────────────────────
 * The operator, having emptied it: *«я считаю, что там можно поместить какие-то другие кнопки,
 * которые более важны»* — without saying which. ⛔ **Do not fill it by guessing.** The slot is
 * recorded as free in R40 and in the plan; what goes there is decided once he sees it empty.
 * Candidates offered, none chosen: the unread counter (W25), «create ticket», the last open ticket.
 */
export function Topbar({ onOpenCommand }: { onOpenCommand: () => void }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      {/* Шаг 1: on a PHONE the rail is the library's sheet, and this is its only opener. Hidden on
          desktop, where the rail is pinned collapsed and nothing may expand it (R41). */}
      <SidebarTrigger className="md:hidden" aria-label="Open navigation" />
      <BackButton />

      <div className="flex-1" />

      {/*
        The search box stays a labelled placeholder until W39, on his own instruction: *«не совсем
        работает, но мы потом ей займёмся. Пока что не вижу смысла»*. Today it opens the command
        palette, which navigates — it does not search, and does not claim to.
      */}
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={onOpenCommand}
        aria-label="Open command palette"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">Go to…</span>
        <kbd className="ml-2 hidden rounded border border-border px-1 text-xs sm:inline">⌘K</kbd>
      </Button>
    </header>
  );
}
