'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { relativeTime } from '@/features/inbox/wire-labels';
import { useStatuses } from '@/features/inbox/use-statuses';
import type { AsyncState } from '@/data/types';
import type { ConversationDetail } from './types';

/**
 * The left properties column (W7 — frame `032-ticket-fields-left-column`, MVP subset per the
 * operator's caption and INDEX §2: brand · requester · assignee · status · Player ID; the cascading
 * Form/L1/L2/L3/PSP taxonomy is post-MVP 4.15 and gets no placeholder rows).
 *
 * Read-only in this pass — the editors («take it», status, tags) dock here in W7-7. Ids render as
 * ids: no directory read exists yet for operator or brand NAMES, and a made-up word would be a
 * confident wrong answer. An empty value renders as an explicit dash, never as an invented default.
 */
export function FieldsColumn({ detail }: { detail: AsyncState<ConversationDetail> }) {
  const { statuses } = useStatuses();

  return (
    <aside
      data-testid="ticket-fields"
      className="w-64 shrink-0 space-y-4 overflow-y-auto border-r border-border py-4 pr-4"
    >
      {detail.status === 'ready' ? (
        <>
          <Field label="Brand" value={detail.data.brandId} mono />
          <Field
            label="Requester"
            value={
              detail.data.identityState === 'unidentified'
                ? 'Not identified' // W9 adds the search-and-attach flow for exactly this state.
                : detail.data.playerId
            }
            mono={detail.data.identityState !== 'unidentified'}
          />
          <Field label="Assignee" value={detail.data.assigneeOperatorId || 'Unassigned'} mono={!!detail.data.assigneeOperatorId} />
          <Field
            label="Status"
            value={statuses.find((s) => s.key === detail.data.statusKey)?.agentName ?? detail.data.statusKey}
          />
          <Field label="Priority" value={detail.data.priority} />
          <Field label="Channel" value={detail.data.channel} />
          <Field label="Player ID" value={detail.data.playerId} mono />
          <Field label="Created" value={relativeTime(detail.data.createdAt)} />
          <Field label="Updated" value={relativeTime(detail.data.updatedAt)} />
        </>
      ) : (
        // The column's own loading/error is quiet: the window's header carries the loud one.
        <div className="space-y-3" data-testid="fields-loading">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
    </aside>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`truncate text-sm ${mono ? 'font-mono' : ''}`} title={value || undefined}>
        {value || '—'}
      </div>
    </div>
  );
}
