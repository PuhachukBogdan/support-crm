'use client';

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState } from '@/data/types';

interface LabelUsageWire {
  id?: string;
  name?: string;
  color?: string;
  usageCount?: number;
}

interface TagRow {
  id: string;
  name: string;
  color: string;
  usageCount: number;
}

/**
 * W16 — the tag registry (subpoint 3.11, roadmap 9.15 minimum): every label the account has, with
 * how many conversations carry it, busiest first — the operator's own numbers were the reason
 * (auto_confirmation ×200k in their Zendesk, next to tags nobody remembered creating).
 *
 * READ-ONLY, deliberately. Creating tags lives where agents work (the ticket window); retiring a
 * dead tag without erasing history is the rest of 9.15 and needs a write the engine does not have
 * yet. A registry that quietly offered "delete" would be offering to rewrite history.
 *
 * ⚠️ `usageCount` counts conversations CARRYING the tag now — links, not historical applications.
 * Said here and on the screen, because "how often was it used" reads as history and this is not it.
 */
export function Tags() {
  const dataAccess = useDataAccess();
  const [tags, setTags] = useState<AsyncState<TagRow[]>>({ status: 'idle' });

  useEffect(() => {
    let alive = true;
    setTags({ status: 'loading' });
    void dataAccess
      .list<LabelUsageWire>('label-usage', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        const rows = page.items
          .filter((t): t is LabelUsageWire & { id: string } => typeof t?.id === 'string' && t.id !== '')
          .map((t) => ({
            id: t.id,
            name: t.name || t.id,
            color: t.color || '',
            usageCount: typeof t.usageCount === 'number' ? t.usageCount : 0,
          }))
          // Busiest first — the question this screen answers is "what do we actually use?"
          .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
        setTags(rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows });
      })
      .catch((e) => alive && setTags({ status: 'error', error: toDataError(e) }));
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="Tag registry" />
      {tags.status === 'ready' ? (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="tags-list">
          {tags.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-2 text-sm" data-testid={`tag-${t.id}`}>
              {t.color && (
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
              <span className="tabular-nums text-muted-foreground" data-testid={`tag-count-${t.id}`}>
                {t.usageCount}
              </span>
            </li>
          ))}
        </ul>
      ) : tags.status === 'error' ? (
        <p className="text-sm text-destructive" data-testid="tags-error">
          {tags.error.message}
        </p>
      ) : tags.status === 'empty' ? (
        <p className="text-sm text-muted-foreground" data-testid="tags-empty">
          No tags exist in this account yet.
        </p>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
      {tags.status === 'ready' && (
        <p className="text-xs text-muted-foreground">
          The count is conversations carrying the tag right now — not how many times it was ever
          applied. Removing a tag from the vocabulary without erasing history is a later point
          (9.15); nothing here writes.
        </p>
      )}
    </div>
  );
}
