'use client';

import { cn } from '@/lib/utils';
import { BUCKETS, type BucketId } from './buckets';
import { ComingSoonBadge } from './coming-soon';

/**
 * The bucket column from Zendesk's Home (`ui-design/screenshots/home.png`): a narrow rail of grouped
 * entries, the selected one filled dark.
 *
 * ⚠️ It sits **inside the screen**, not in the app shell. The shell's rail lists *modules* (roadmap
 * 9.14); this lists narrowings of one module's own data. Putting it in the shell would make the Inbox
 * the only screen whose contents leak into global navigation — and 9.2a's saved views land here too,
 * beneath these, which is the arrangement R15 fixes: **own work first, never scroll to reach it.**
 */
export function BucketRail({
  value,
  onChange,
}: {
  value: BucketId;
  onChange: (id: BucketId) => void;
}) {
  // Preserve the declared order while grouping — Zendesk's headings are the structure, not decoration.
  const groups = BUCKETS.reduce<{ group: string; items: typeof BUCKETS }[]>((acc, bucket) => {
    const last = acc[acc.length - 1];
    if (last && last.group === bucket.group) last.items = [...last.items, bucket];
    else acc.push({ group: bucket.group, items: [bucket] });
    return acc;
  }, []);

  return (
    <nav aria-label="Inbox sections" data-testid="bucket-rail" className="w-52 shrink-0 space-y-4">
      {groups.map(({ group, items }) => (
        <div key={group} className="space-y-1">
          <p className="border-b border-border pb-1 text-xs font-medium text-muted-foreground">
            {group}
          </p>
          {items.map((bucket) => {
            const active = bucket.id === value;
            if (bucket.comingSoon) {
              return (
                <div
                  key={bucket.id}
                  data-testid={`bucket-${bucket.id}`}
                  // ⚠️ Not a button, not focusable, not announced — the shape is visible and says so.
                  // A disabled-looking control that swallows clicks is the thing FR-015b forbids.
                  aria-hidden
                  className="flex w-full cursor-default select-none items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground/70"
                >
                  <span className="truncate">{bucket.label}</span>
                  <ComingSoonBadge className="ml-auto" />
                </div>
              );
            }
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
        </div>
      ))}
    </nav>
  );
}
