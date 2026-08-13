'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

/**
 * ⭐ W24 (R43) — the list's search, REAL now, over exactly the field the list shows: `[номер] тема`.
 * A pasted `[1043]` or `#1043` means the number (the service edge strips the dressing); any other
 * text matches the subject as a substring. This replaced `SearchPlaceholder`, whose "coming soon"
 * badge covered a promise this box no longer makes: player/assignee/message text stay W39's separate
 * screen — which is why the placeholder text below names ONLY what actually works.
 *
 * ⚠️ Debounced, not on-Enter: the list narrows as the person types, matching how the header funnels
 * behave — and a stale in-flight response cannot clobber a newer one because the query layer keys on
 * the filters object (same path every funnel uses).
 */
export function InboxSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear-all (and any other external reset) must empty the box too — the box reflects the filter,
  // it does not own it.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (next: string) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const trimmed = next.trim();
      onChange(trimmed.length > 0 ? trimmed : undefined);
    }, 350);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        data-testid="inbox-search"
        aria-label="Search tickets by number or subject"
        placeholder="Search — ticket number or subject…"
        className="h-9 pl-9"
        value={draft}
        onChange={(e) => commit(e.target.value)}
      />
    </div>
  );
}
