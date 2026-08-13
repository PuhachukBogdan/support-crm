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
import { PRIORITY_OPTIONS } from '@/data/priorities';
import { EditableChoice, ReadOnlyValue } from './editable';
import { IdentityPanel } from './identity-panel';
import type { AsyncState } from '@/data/types';
import type { TicketState } from '@/store/ticket/ticket.slice';
import type { ConversationDetail, LabelWire } from './types';

/**
 * The left properties column (W7 — frame `032-ticket-fields-left-column`, MVP subset per the
 * operator's caption and INDEX §2: brand · requester · assignee · status · Player ID; the cascading
 * Form/L1/L2/L3/PSP taxonomy is post-MVP 4.15 and gets no placeholder rows).
 *
 * ⭐ **2026-08-10 — the column became editable** (operator: *«все остальные поля… тянутся сами, но мы
 * их должны иметь возможность редактировать в случае чего»*). Every property that HAS a write is one
 * now, in place and without a frame around it — see `editable.tsx` for the shape and why.
 *
 * ── What stayed read-only, and why each one did ─────────────────────────────────────────────────
 * Recorded rather than left to look like an oversight, because "this cannot be edited" and "nobody
 * built the editor" are indistinguishable from the screen — the exact confusion `Priority` caused
 * until its write was built the same day.
 *  · **Channel** — a fact about how the ticket ARRIVED, not a property of it. There is no write at any
 *    tier, and there should not be: editing it would make a mail thread claim to be a chat, and the
 *    reply path follows the channel.
 *  · **Created / Updated** — the clock's, not a person's.
 *  · **Player ID** — changed by ATTACHING a customer, not by typing an id. Typing one would let a
 *    ticket point at a player nobody verified; the attach flow exists because that check matters.
 */
export function FieldsColumn({
  detail,
  labels,
  accountLabels,
  mutation,
  myOperatorId,
  canLookUp,
  brands,
  canSetBrand,
  onTakeIt,
  onAttachLabel,
  onDetachLabel,
  onIdentityChanged,
  onSetStatus,
  onSetPriority,
  onSetBrand,
}: {
  detail: AsyncState<ConversationDetail>;
  labels: AsyncState<LabelWire[]>;
  accountLabels: AsyncState<LabelWire[]>;
  mutation: TicketState['mutation'];
  /** `''` until `/me/operator` answers — «take it» stays unrendered rather than mis-assigning. */
  myOperatorId: string;
  /** W9: holder of `crm.contact.lookup`? RENDER-only — the server refuses regardless. */
  canLookUp: boolean;
  /** The account's own brands, for the Brand chooser. Never a list spelled in this file (rule 6). */
  brands: readonly { brandId: string; name: string }[];
  /** Holder of `crm.conversation.set_brand`? RENDER-only, like every other key on this screen. */
  canSetBrand: boolean;
  onTakeIt: (operatorId: string) => void;
  onAttachLabel: (labelId: string) => void;
  onDetachLabel: (labelId: string) => void;
  /** Identity changed (attached/detached) ⇒ the whole window re-reads. */
  onIdentityChanged: () => void;
  onSetStatus: (statusKey: string) => void;
  onSetPriority: (priority: string) => void;
  onSetBrand: (brandId: string) => void;
}) {
  const { statuses } = useStatuses();
  const busy = mutation.status === 'busy';

  // ⭐ From the ACCOUNT's catalogue, active only: a retired status renders on an old ticket (see
  // `EditableChoice`) but cannot be chosen again — the unbuildable-contradiction rule the Inbox
  // funnel learned the hard way.
  const statusOptions = statuses
    .filter((s) => s.active)
    .map((s) => ({ value: s.key, label: s.agentName }));
  const brandOptions = brands.map((b) => ({ value: b.brandId, label: b.name || b.brandId }));

  return (
    <aside
      data-testid="ticket-fields"
      // Width belongs to the wrapper in ticket-window (9.9: the drag writes ONE element's style).
      className="h-full w-full space-y-4 overflow-y-auto border-r border-border py-4 pr-4"
    >
      {detail.status === 'ready' ? (
        <>
          <Labelled label="Brand">
            {canSetBrand ? (
              <EditableChoice
                value={detail.data.brandId}
                options={brandOptions}
                placeholder={brandOptions.length === 0 ? 'No brands configured' : 'Choose a brand'}
                onCommit={onSetBrand}
                disabled={busy}
                ariaLabel="Brand"
                testId="field-brand"
              />
            ) : (
              // Its own permission server-side (R22): an agent may not change the brand, and a
              // control that 403s is worse than one that is not offered.
              <ReadOnlyValue value={brandName(brands, detail.data.brandId)} />
            )}
          </Labelled>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Requester</div>
            <div
              className={`truncate text-sm ${detail.data.identityState !== 'unidentified' ? 'font-mono' : ''}`}
            >
              {detail.data.identityState === 'unidentified' ? 'Not identified' : detail.data.playerId || '—'}
            </div>
            {/* ⭐ W9: the search-and-attach flow lives HERE and nowhere else — inside the ticket that
                has no player. It renders nothing without `crm.contact.lookup` (render-only gating).
                ⭐ 2026-08-10: FOLDED behind one link — the operator asked why a contact search sits on
                a ticket at all («не вижу в этом смысла»). The capability is the only way to attach a
                customer (ADR 0044 §4), so it stayed; what went is the box sitting open by default. */}
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
          <Labelled label="Status">
            <EditableChoice
              value={detail.data.statusKey}
              options={statusOptions}
              placeholder="Choose a status"
              onCommit={onSetStatus}
              disabled={busy}
              ariaLabel="Status"
              testId="field-status"
            />
          </Labelled>
          <Labelled label="Priority">
            <EditableChoice
              value={detail.data.priority}
              options={PRIORITY_OPTIONS}
              placeholder="None"
              onCommit={onSetPriority}
              disabled={busy}
              ariaLabel="Priority"
              testId="field-priority"
              // ⚠️ Clearing is a real state — it is the one every ticket is created in — so it must
              // be reachable, or the field becomes a one-way door.
              allowClear
              clearLabel="None"
            />
          </Labelled>
          <Labelled label="Channel">
            <ReadOnlyValue
              value={detail.data.channel}
              hint="How this ticket arrived. Not editable — the reply path follows it."
            />
          </Labelled>
          <Labelled label="Player ID">
            <ReadOnlyValue value={detail.data.playerId} mono hint="Changed by attaching a customer." />
          </Labelled>
          <Labelled label="Created">
            <ReadOnlyValue value={relativeTime(detail.data.createdAt)} />
          </Labelled>
          <Labelled label="Updated">
            <ReadOnlyValue value={relativeTime(detail.data.updatedAt)} />
          </Labelled>
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

/** Label above, value below — the one layout every row in this column uses. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/**
 * ⚠️ The brand's NAME when the account's list has it, and the raw id when it does not.
 *
 * Not a guess and not a dash: an id the brands read does not cover is a real state (a brand removed
 * from the account, or a read that failed), and showing the id is the only honest answer — a dash
 * would say "no brand", which is a different fact.
 */
function brandName(brands: readonly { brandId: string; name: string }[], id: string): string {
  return brands.find((b) => b.brandId === id)?.name || id;
}
