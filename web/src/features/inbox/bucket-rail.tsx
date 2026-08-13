'use client';

import { cn } from '@/lib/utils';
import { BUCKETS, type BucketId } from './buckets';

/**
 * ⭐ The R38 rail: **five buttons on categories** — Inbox · Open · Ждут · Solved · Archive. The
 * visual stays Zendesk's Home column (`screenshots/home/016`): a narrow rail, the selected entry a
 * dark pill; the STRUCTURE is the operator's own five-bucket decision replacing Zendesk's grouped
 * headings.
 *
 * ⚠️ **No numbers on the buttons** (R38): counts are 9.2a's, the unread badge is 9.12's. A rail that
 * sometimes shows a stale number is worse than one that shows none.
 *
 * ⚠️ It sits **inside the screen**, not in the app shell. The shell's rail lists *modules* (roadmap
 * 9.14); this lists narrowings of one module's own data — and 9.2a's saved views land beneath these,
 * which is the arrangement R15 fixes: **own work first, never scroll to reach it.**
 */
export function BucketRail({
  value,
  onChange,
}: {
  value: BucketId;
  onChange: (id: BucketId) => void;
}) {
  return (
    <nav aria-label="Inbox sections" data-testid="bucket-rail" className="w-52 shrink-0 space-y-1">
      {BUCKETS.map((bucket) => {
        const active = bucket.id === value;
        return (
          <button
            key={bucket.id}
            type="button"
            data-testid={`bucket-${bucket.id}`}
            aria-current={active ? 'true' : undefined}
            onClick={() => onChange(bucket.id)}
            className={cn(
              'block w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {bucket.label}
          </button>
        );
      })}
    </nav>
  );
}
