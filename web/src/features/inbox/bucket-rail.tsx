'use client';

import { cn } from '@/lib/utils';
import { useSession } from '@/session';
import {
  ARCHIVE_BUCKETS,
  ARCHIVE_HEADING,
  BUCKETS,
  SHELF_BUCKETS,
  SHELF_VIEW_PERMISSION,
  type Bucket,
  type BucketId,
} from './buckets';

/**
 * ⭐ The R39 rail: **four buttons on categories, then the archive as a SECTION** — Inbox · В работе ·
 * Ждут клиента · Решённые, a labelled separator, «Весь архив». The visual stays Zendesk's Home
 * column (`screenshots/home/016`): a narrow rail, the selected entry a dark pill; the STRUCTURE is
 * the operator's own recomposition of his R38 five buttons, made looking at the running product.
 *
 * ⚠️ The archive is a REGION of this rail, never a separate page: same list, same columns, same
 * filters to the right — only the narrowing differs. W33's granted views will land under the same
 * heading.
 *
 * ⚠️ **No numbers on the buttons** (R38, kept by R39): counts are 9.2a's, the unread badge is
 * 9.12's. A rail that sometimes shows a stale number is worse than one that shows none.
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
  const session = useSession();
  /**
   * ⭐ W27 / 036: the shelf buckets render only for holders of the view key — RENDER-only, like
   * every `permissionKeys` read (the refusal itself is the server's, at both tiers). For everyone
   * else the section simply ends at «Весь архив», with no gap where a right would be.
   */
  const canSeeShelf =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes(SHELF_VIEW_PERMISSION);

  return (
    <nav aria-label="Inbox sections" data-testid="bucket-rail" className="w-52 shrink-0 space-y-1">
      {BUCKETS.map((bucket) => (
        <BucketButton key={bucket.id} bucket={bucket} active={bucket.id === value} onChange={onChange} />
      ))}

      {/* R47: the archive section — visually separated by a line AND a heading, same page. */}
      <div role="separator" aria-label={ARCHIVE_HEADING} className="pt-3" data-testid="archive-separator">
        <div className="border-t border-border" />
        <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {ARCHIVE_HEADING}
        </p>
      </div>
      {ARCHIVE_BUCKETS.map((bucket) => (
        <BucketButton key={bucket.id} bucket={bucket} active={bucket.id === value} onChange={onChange} />
      ))}
      {canSeeShelf &&
        SHELF_BUCKETS.map((bucket) => (
          <BucketButton key={bucket.id} bucket={bucket} active={bucket.id === value} onChange={onChange} />
        ))}
    </nav>
  );
}

function BucketButton({
  bucket,
  active,
  onChange,
}: {
  bucket: Bucket;
  active: boolean;
  onChange: (id: BucketId) => void;
}) {
  return (
    <button
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
}
