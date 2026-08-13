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
import { presenceLabel } from '@/data/presence';
import { EditableChoice, EditableText, ReadOnlyValue } from './editable';
import { useAssignableOperators } from './use-assignable-operators';
import { IdentityPanel } from './identity-panel';
import { CustomFieldsBlock } from './custom-fields-block';
import type { AsyncState } from '@/data/types';
import type { TicketState } from '@/store/ticket/ticket.slice';
import type { ConversationDetail, LabelWire } from './types';

/**
 * The left properties column (W7 — frame `032-ticket-fields-left-column`, MVP subset per the
 * operator's caption and INDEX §2: brand · requester · assignee · status · Player ID.
 * ⭐ W30 delivered the reserved half: the cascading Form/L1→L2→L3 taxonomy and the account's custom
 * fields render below Priority as `CustomFieldsBlock` — self-owned data, per-caller resolved).
 *
 * ⭐ **2026-08-10 — the column became editable** (operator: *«все остальные поля… тянутся сами, но мы
 * их должны иметь возможность редактировать в случае чего»*). Every property that HAS a write is one
 * now, in place and without a frame around it — see `editable.tsx` for the shape and why.
 *
 * ⭐⭐ **2026-08-10, second pass — the two the operator still could not change.** Reading the shipped
 * screen: *«я всё ещё не вижу возможности менять поля типа бренд, ассайни»*, and on Player ID, *«не
 * вижу ни одной причины, почему нельзя сделать placeholder, чтобы его можно было заполнять»*.
 *
 *  · **Assignee** was genuinely read-only — one «take it» button that can only name the caller. It is
 *    a chooser over the account's staff now (`use-assignable-operators.ts`), with «take it» kept
 *    beside it because that control needs neither of the chooser's two permissions.
 *  · **Player ID** is editable, and the refusal recorded here on the morning of the same day is
 *    OVERRULED by the operator's own instruction. What the old note got right stays true — a typed id
 *    is not a verified one — so it is written down where it belongs now, on the field itself.
 *  · **Brand** was already a chooser and he still could not see it. That was not a permission and not
 *    a missing write: an editable field and a read-only one rendered IDENTICALLY at rest. Fixed in
 *    `editable.tsx`, which is where the mistake was.
 *
 * ── What stayed read-only, and why each one did ─────────────────────────────────────────────────
 * Recorded rather than left to look like an oversight, because "this cannot be edited" and "nobody
 * built the editor" are indistinguishable from the screen — the exact confusion `Priority` caused
 * until its write was built the same day.
 *  · **Channel** — a fact about how the ticket ARRIVED, not a property of it. There is no write at any
 *    tier, and there should not be: editing it would make a mail thread claim to be a chat, and the
 *    reply path follows the channel.
 *  · **Created / Updated** — the clock's, not a person's.
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
  onSetAssignee,
  onSetPlayerId,
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
  /** `''` unassigns — a real state, so the chooser offers it (see the slice's note). */
  onSetAssignee: (operatorId: string) => void;
  onSetPlayerId: (playerId: string) => void;
}) {
  const { statuses } = useStatuses();
  const busy = mutation.status === 'busy';
  // ⓘ Empty for anybody without BOTH `users.list.view` and `crm.conversation.assign` — the hook says
  // why, and the field falls back to the read-only name plus «take it» rather than to a broken menu.
  const { operators: assignable } = useAssignableOperators();

  // ⭐ From the ACCOUNT's catalogue, active only: a retired status renders on an old ticket (see
  // `EditableChoice`) but cannot be chosen again — the unbuildable-contradiction rule the Inbox
  // funnel learned the hard way.
  const statusOptions = statuses
    .filter((s) => s.active)
    .map((s) => ({ value: s.key, label: s.agentName }));
  const brandOptions = brands.map((b) => ({ value: b.brandId, label: b.name || b.brandId }));
  /**
   * The staff, by name, with their presence in the label — *«Ivan — On shift»*. Handing a ticket to
   * somebody on a break is a legitimate act (it is how work is queued for a returning shift), so the
   * state is stated rather than used to hide the option: this control routes work, and hiding a
   * colleague from it would hide the reason the ticket then sits still.
   */
  const assigneeOptions = assignable.map((o) => {
    const state = presenceLabel(o.state);
    return { value: o.operatorId, label: state ? `${o.displayName} — ${state}` : o.displayName };
  });

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
                  the ticket is already mine (taking what I hold would be a no-op button).
                  ⭐ Kept beside the chooser on purpose: it needs NEITHER of the chooser's two
                  permissions, so for a line agent it remains the only assignment control there is. */}
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
            {assigneeOptions.length > 0 ? (
              /* ⭐ 2026-08-10 — the chooser the operator asked for. `allowClear` because Unassigned is
                 a real state (the one every new ticket is in) and a field that cannot return to it is
                 a one-way door — `setPriority`'s lesson, applied before it could be repeated. */
              <EditableChoice
                value={detail.data.assigneeOperatorId}
                options={assigneeOptions}
                placeholder="Unassigned"
                onCommit={onSetAssignee}
                disabled={busy}
                ariaLabel="Assignee"
                testId="field-assignee"
                allowClear
                clearLabel="Unassigned"
              />
            ) : (
              /* ⚠️ The raw id, when the staff list is unreadable to this caller — NOT a dash and not a
                 blank. "Somebody holds this and I cannot resolve who" and "nobody holds this" are
                 opposite facts, and the id is the only honest way to say the first. */
              <ReadOnlyValue
                value={detail.data.assigneeOperatorId || 'Unassigned'}
                mono={detail.data.assigneeOperatorId !== ''}
                hint={
                  detail.data.assigneeOperatorId
                    ? 'Assigned. Naming a colleague needs the staff directory.'
                    : 'Nobody holds this ticket yet.'
                }
              />
            )}
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
          {/* ⭐ W30 (4.15): the form + its fields — the frame-032 order puts the taxonomy right
              after the workflow properties. Its own read, its own writes, degrades alone. */}
          <CustomFieldsBlock conversationId={detail.data.id} />
          <Labelled label="Channel">
            <ReadOnlyValue
              value={detail.data.channel}
              hint="How this ticket arrived. Not editable — the reply path follows it."
            />
          </Labelled>
          <Labelled label="Player ID">
            {/**
             * ⭐⭐ 2026-08-10 — fillable, on the operator's instruction: *«не вижу ни одной причины,
             * почему нельзя сделать placeholder, чтобы его можно было заполнять»*.
             *
             * ⚠️ **This OVERRULES the note this file carried the same morning** — *"changed by
             * ATTACHING a customer, not by typing an id"*. The reasoning behind it was not wrong and is
             * not discarded: a typed id is not a verified one, and the search-and-attach flow above
             * exists because that verification matters. What was wrong was making it the ONLY way in.
             * Both live here now, and the server refuses an id that names no player in this account
             * either way — the check that actually protects the record was never this control's.
             *
             * ⓘ It is the identity pair's own route (`PUT /conversations/:id/player`), so it needs
             * `crm.contact.lookup` — the same key the attach flow needs, which is why the render gate
             * is the same `canLookUp`. Without it the field reads, and says why it cannot be changed.
             *
             * ⛔ CLEARING is deliberately not reachable here: detaching carries a warning that must be
             * read first (ADR 0044 §5) and that flow lives in `IdentityPanel`. `EditableText` refuses
             * an empty commit, so this cannot become a silent detach.
             */}
            {canLookUp ? (
              <EditableText
                value={detail.data.playerId}
                placeholder="Add a player ID"
                onCommit={onSetPlayerId}
                disabled={busy}
                ariaLabel="Player ID"
                testId="field-player-id"
                className="font-mono"
              />
            ) : (
              <ReadOnlyValue
                value={detail.data.playerId}
                mono
                hint="Changed by attaching a customer."
              />
            )}
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
