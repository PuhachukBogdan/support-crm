'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { useStatuses } from '@/features/inbox/use-statuses';
import { useTicket } from './use-ticket';
import { useTicketLive } from './use-ticket-live';
import { FieldsColumn } from './fields-column';
import { Thread } from './thread';
import { Composer } from './composer';

/**
 * The ticket window (block W7, subpoint 2.6 — frame `031-ticket-window-full`, decision §7 of the
 * reference: three columns, internal/public composer switch, submit-as-status, «take it»).
 *
 * What is HERE now: header (the 4.18 subject + status + channel), the left properties column, the
 * thread, the composer. What is deliberately NOT here yet: the right context panel and the open-
 * tickets tabs (W10 — the shell's context-panel slot is their home), «Apply macro» (W8),
 * resizable panels (W8/9.9).
 *
 * Opening this page IS the read event: the gateway records a ConversationReadMark from the caller's
 * own identity on `GET /conversations/:id`, which is what feeds the agent rail's "opened" leg —
 * the window gets that for free and must NOT try to record anything itself.
 */
export function TicketWindow({ id }: { id: string }) {
  const t = useTicket(id);
  // A new message or a status/assignee change re-reads this window by itself (subpoint 2.6's
  // «подписка на события») — scoped to THIS conversation, since the stream is account-wide.
  useTicketLive(id, t.refresh);
  const { statuses } = useStatuses();

  const statusName = (key: string) => statuses.find((s) => s.key === key)?.agentName ?? key;
  // «Submit as …» offers the ACTIVE catalogue by agent name — a retired status renders on old rows
  // but cannot be submitted to, the same unbuildable-contradiction rule as the Inbox funnel.
  const submitStatuses = useMemo(
    () => statuses.filter((s) => s.active).map((s) => ({ key: s.key, agentName: s.agentName })),
    [statuses],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ticket-window">
      <header className="flex shrink-0 items-center gap-3 border-b border-border pb-3">
        <Link
          href="/"
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          data-testid="ticket-back"
        >
          ← Inbox
        </Link>
        {t.detail.status === 'ready' ? (
          <>
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="ticket-subject">
              {/* An open derivation window (4.18) means the ticket genuinely has no subject YET —
                  said as a state, never faked with the first message's text client-side. */}
              {t.detail.data.subject || 'No subject yet'}
            </h1>
            <Badge variant="secondary" data-testid="ticket-status">
              {statusName(t.detail.data.statusKey)}
            </Badge>
            {t.detail.data.channel && (
              <span className="shrink-0 text-xs text-muted-foreground">via {t.detail.data.channel}</span>
            )}
            {t.detail.data.reference && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                #{t.detail.data.reference}
              </span>
            )}
          </>
        ) : t.detail.status === 'error' ? (
          <div className="flex-1" data-testid="ticket-detail-error">
            <ErrorState error={t.detail.error} onRetry={t.refresh} />
          </div>
        ) : (
          <Skeleton className="h-6 w-1/2" />
        )}
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <FieldsColumn detail={t.detail} />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Thread state={t.thread} truncated={t.threadTruncated} onRetry={t.refresh} />
          <Composer send={t.send} sendState={t.sendState} statusOptions={submitStatuses} />
        </main>

        {/* The right rail's future home (W10): the shell's context-panel slot, not this file. */}
      </div>
    </div>
  );
}
