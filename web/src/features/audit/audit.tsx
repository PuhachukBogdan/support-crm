'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/composites/page-header/page-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { DataError } from '@/data/types';

/**
 * W16 — the audit log gets its reader (subpoint 3.12, roadmap 9.18 minimum).
 *
 * The plan's own words: the most profitable point in it — the trail has been WRITTEN since April
 * (permission grants, contact reveals, exports, role changes, channel intake, config edits) and no
 * screen could read it. This is one table over feature 015's federated `GET /audit`, filtered by
 * ACTION CLASS — the six-class catalogue is the read's own vocabulary, and filtering by class is
 * the question a reviewer actually asks ("show me every permission change").
 *
 * ⚠️ Entries are append-only and this screen is READ-ONLY by construction: no write path exists on
 * the wire at all, for anyone (feature 015's design), so there is nothing here to render-gate.
 * Reading the log is itself recorded (`audit.read`) — a reviewer sees their own visit appear.
 */

interface AuditEntryWire {
  id?: string;
  actorUserId?: string;
  actorKind?: string;
  actorRef?: string;
  underPreview?: boolean;
  action?: string;
  targetRef?: string;
  detailJson?: string;
  createdAt?: string;
  source?: string;
}

interface StaffWire {
  userId?: string;
  email?: string;
}

/**
 * ⚠️ The six classes live server-side in `libs/common/src/audit/catalogue.ts` and the route
 * validates against them; this list mirrors it for the filter control, with the same recorded
 * trade as the roles and status categories before it: a class added there appears here by edit.
 */
const AUDIT_CLASSES = ['privilege', 'access', 'assignment', 'export', 'deletion', 'retention'] as const;

export function Audit() {
  const dataAccess = useDataAccess();
  const [entries, setEntries] = useState<AuditEntryWire[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle');
  const [error, setError] = useState<DataError | null>(null);
  const [actionClass, setActionClass] = useState('');
  const [staff, setStaff] = useState<Map<string, string>>(new Map());

  const load = useCallback(
    async (klass: string, after: string | null) => {
      setState('loading');
      setError(null);
      try {
        const page = await dataAccess.list<AuditEntryWire>('audit-entries', {
          limit: 50,
          cursor: after,
          filters: klass ? { actionClass: klass } : {},
        });
        setEntries((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setState(page.items.length === 0 && !after ? 'empty' : 'ready');
      } catch (e) {
        setError(toDataError(e));
        setState('idle');
      }
    },
    [dataAccess],
  );

  useEffect(() => {
    void load('', null);
    // Actor ids → emails, joined from the people list the reviewer may already see (W14). Degrades
    // ALONE: without it the table shows ids — worse-looking, still true.
    void dataAccess
      .list<StaffWire>('staff', { limit: 100 })
      .then((page) => {
        const map = new Map<string, string>();
        for (const p of page.items) if (p.userId && p.email) map.set(p.userId, p.email);
        setStaff(map);
      })
      .catch(() => undefined);
  }, [dataAccess, load]);

  const pickClass = (klass: string) => {
    setActionClass(klass);
    // ⚠️ The cursor belongs to the query it was minted under — a class change starts from page one.
    setCursor(null);
    void load(klass, null);
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-4 overflow-y-auto py-2">
      <PageHeader
        title="Audit log"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" data-testid="audit-class-filter">
                {actionClass || 'All classes'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => pickClass('')}>All classes</DropdownMenuItem>
              {AUDIT_CLASSES.map((c) => (
                <DropdownMenuItem key={c} onSelect={() => pickClass(c)}>
                  {c}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {error && (
        <p className="text-sm text-destructive" data-testid="audit-error">
          {error.message}
        </p>
      )}
      {state === 'empty' && (
        <p className="text-sm text-muted-foreground" data-testid="audit-empty">
          Nothing recorded {actionClass ? 'in this class' : 'yet'}.
        </p>
      )}
      {(state === 'ready' || (state === 'loading' && entries.length > 0)) && (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="audit-list">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-2 text-sm" data-testid={`audit-${e.id}`}>
              <span className="w-40 shrink-0 tabular-nums text-xs text-muted-foreground">
                {formatTime(e.createdAt)}
              </span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.action || '—'}</code>
              <span className="min-w-0 truncate" data-testid={`audit-actor-${e.id}`}>
                {actorLabel(e, staff)}
              </span>
              {e.underPreview && <Badge variant="outline">under preview</Badge>}
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {e.targetRef ? `→ ${e.targetRef}` : ''}
                {detailText(e.detailJson)}
              </span>
              <span className="text-xs text-muted-foreground">{e.source}</span>
            </li>
          ))}
        </ul>
      )}
      {state === 'loading' && entries.length === 0 && <Skeleton className="h-24 w-full" />}
      {cursor && state === 'ready' && (
        <Button size="sm" variant="outline" className="self-center" data-testid="audit-more" onClick={() => void load(actionClass, cursor)}>
          Load more
        </Button>
      )}
    </div>
  );
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 19);
}

/** The REAL actor: a person (joined to their email when the people list answers, the id otherwise)
 *  or the system — a rule, a tick, a stranger's delivery — shown by its recorded ref. */
function actorLabel(e: AuditEntryWire, staff: Map<string, string>): string {
  if (e.actorKind === 'ACTOR_KIND_SYSTEM' || (!e.actorUserId && e.actorRef)) {
    return `system${e.actorRef ? ` (${e.actorRef})` : ''}`;
  }
  if (!e.actorUserId) return '—';
  return staff.get(e.actorUserId) ?? e.actorUserId;
}

/** The PII-free detail, flattened to `k=v` pairs. It arrives validated (a closed per-class key
 *  allow-list, values that cannot be contact data) — this only makes it readable, never richer. */
function detailText(detailJson?: string): string {
  if (!detailJson) return '';
  try {
    const detail = JSON.parse(detailJson) as Record<string, unknown>;
    const pairs = Object.entries(detail).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : String(v)}`);
    return pairs.length > 0 ? `  ·  ${pairs.join('  ')}` : '';
  } catch {
    return '';
  }
}
