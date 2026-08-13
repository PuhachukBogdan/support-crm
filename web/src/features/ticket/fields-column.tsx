'use client';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { relativeTime } from '@/features/inbox/wire-labels';
import { useStatuses } from '@/features/inbox/use-statuses';
import { IdentityPanel } from './identity-panel';
import type { AsyncState } from '@/data/types';
import type { TicketState } from '@/store/ticket/ticket.slice';
import type { ConversationDetail, LabelWire } from './types';

/**
 * The left properties column (W7 — frame `032-ticket-fields-left-column`, MVP subset per the
 * operator's caption and INDEX §2: brand · requester · assignee · status · Player ID; the cascading
 * Form/L1/L2/L3/PSP taxonomy is post-MVP 4.15 and gets no placeholder rows).
 *
 * Read-only in this pass — the editors («take it», status, tags) dock here in W7-7. Ids render as
 * ids: no directory read exists yet for operator or brand NAMES, and a made-up word would be a
 * confident wrong answer. An empty value renders as an explicit dash, never as an invented default.
 */
export function FieldsColumn({
  detail,
  labels,
  accountLabels,
  mutation,
  myOperatorId,
  canLookUp,
  onTakeIt,
  onAttachLabel,
  onDetachLabel,
  onIdentityChanged,
}: {
  detail: AsyncState<ConversationDetail>;
  labels: AsyncState<LabelWire[]>;
  accountLabels: AsyncState<LabelWire[]>;
  mutation: TicketState['mutation'];
  /** `''` until `/me/operator` answers — «take it» stays unrendered rather than mis-assigning. */
  myOperatorId: string;
  /** W9: holder of `crm.contact.lookup`? RENDER-only — the server refuses regardless. */
  canLookUp: boolean;
  onTakeIt: (operatorId: string) => void;
  onAttachLabel: (labelId: string) => void;
  onDetachLabel: (labelId: string) => void;
  /** Identity changed (attached/detached) ⇒ the whole window re-reads. */
  onIdentityChanged: () => void;
}) {
  const { statuses } = useStatuses();
  const busy = mutation.status === 'busy';

  return (
    <aside
      data-testid="ticket-fields"
      // Width belongs to the wrapper in ticket-window (9.9: the drag writes ONE element's style).
      className="h-full w-full space-y-4 overflow-y-auto border-r border-border py-4 pr-4"
    >
      {detail.status === 'ready' ? (
        <>
          <Field label="Brand" value={detail.data.brandId} mono />
          <div>
            <div className="text-xs font-medium text-muted-foreground">Requester</div>
            <div
              className={`truncate text-sm ${detail.data.identityState !== 'unidentified' ? 'font-mono' : ''}`}
            >
              {detail.data.identityState === 'unidentified' ? 'Not identified' : detail.data.playerId || '—'}
            </div>
            {/* ⭐ W9: the search-and-attach flow lives HERE and nowhere else — inside the ticket that
                has no player. It renders nothing without `crm.contact.lookup` (render-only gating). */}
            <div className="mt-1">
              <IdentityPanel
                conversationId={detail.data.id}
                identified={detail.data.identityState === 'identified'}
                canLookUp={canLookUp}
                onChanged={onIdentityChanged}
              />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <div className="text-xs font-medium text-muted-foreground">Assignee</div>
              {/* «take it» (frame 031): PUT with the caller's OWN id — there is no way to name
                  anyone else here, mirroring 5.11. Hidden while identity is unresolved, and when
                  the ticket is already mine (taking what I hold would be a no-op button). */}
              {myOperatorId !== '' && detail.data.assigneeOperatorId !== myOperatorId && (
                <button
                  type="button"
                  data-testid="take-it"
                  disabled={busy}
                  onClick={() => onTakeIt(myOperatorId)}
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                >
                  take it
                </button>
              )}
            </div>
            <div
              className={`truncate text-sm ${detail.data.assigneeOperatorId ? 'font-mono' : ''}`}
              title={detail.data.assigneeOperatorId || undefined}
            >
              {detail.data.assigneeOperatorId || 'Unassigned'}
            </div>
          </div>
          <Field
            label="Status"
            value={statuses.find((s) => s.key === detail.data.statusKey)?.agentName ?? detail.data.statusKey}
          />
          <Field label="Priority" value={detail.data.priority} />
          <Field label="Channel" value={detail.data.channel} />
          <Field label="Player ID" value={detail.data.playerId} mono />
          <Field label="Created" value={relativeTime(detail.data.createdAt)} />
          <Field label="Updated" value={relativeTime(detail.data.updatedAt)} />
          <TagsBlock
            labels={labels}
            accountLabels={accountLabels}
            busy={busy}
            onAttach={onAttachLabel}
            onDetach={onDetachLabel}
          />
          {mutation.status === 'error' && (
            <p className="text-xs text-destructive" data-testid="fields-error">
              {mutation.error.message}
            </p>
          )}
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

/**
 * Tags (W7-7). Attach/detach over the account's EXISTING registry — creating tags belongs to the
 * admin registry screen (W16, frame 067 «это нужно сразу» goes there), so no create control here.
 * Both writes are idempotent server-side; a failed pair is safe to retry.
 */
function TagsBlock({
  labels,
  accountLabels,
  busy,
  onAttach,
  onDetach,
}: {
  labels: AsyncState<LabelWire[]>;
  accountLabels: AsyncState<LabelWire[]>;
  busy: boolean;
  onAttach: (labelId: string) => void;
  onDetach: (labelId: string) => void;
}) {
  const mine = labels.status === 'ready' ? labels.data : [];
  const all = accountLabels.status === 'ready' ? accountLabels.data : [];
  const attachedIds = new Set(mine.map((l) => l.id));
  const offerable = all.filter((l) => !attachedIds.has(l.id));

  return (
    <div data-testid="ticket-tags">
      <div className="mb-1 flex items-baseline justify-between">
        <div className="text-xs font-medium text-muted-foreground">Tags</div>
        {offerable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="tag-add"
                disabled={busy}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                + add
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {offerable.map((l) => (
                <DropdownMenuItem key={l.id} onSelect={() => onAttach(l.id)}>
                  {l.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {labels.status === 'error' ? (
        // The tags block degrades alone — an annotation read must never take the window with it.
        <p className="text-xs text-muted-foreground">Tags are unavailable right now.</p>
      ) : mine.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tags.</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {mine.map((l) => (
            <li key={l.id}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {l.name}
                <button
                  type="button"
                  aria-label={`Remove tag ${l.name}`}
                  disabled={busy}
                  onClick={() => onDetach(l.id)}
                  className="rounded px-1 hover:bg-muted disabled:opacity-50"
                >
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
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
