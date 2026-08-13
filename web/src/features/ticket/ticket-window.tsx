'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { useStatuses } from '@/features/inbox/use-statuses';
import { useMyOperator } from '@/features/inbox/use-my-operator';
// One brands read for the product, not a second copy of the same three lines (W11 wrote it).
import { useBrands } from '@/features/contacts/use-brands';
import { useSession } from '@/session';
import { EditableText } from './editable';
import { useTicket } from './use-ticket';
import { useTicketLive } from './use-ticket-live';
import { useTemplates } from './use-templates';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useContextPanel } from '@/components/shell/context-panel';
import { TicketContextPanel } from './context-panel';
import { FieldsColumn } from './fields-column';
import { Thread } from './thread';
import { Composer } from './composer';

/**
 * The ticket window (block W7, subpoint 2.6 — frame `031-ticket-window-full`, decision §7 of the
 * reference: three columns, internal/public composer switch, submit-as-status, «take it»).
 *
 * What is HERE now: header (the 4.18 subject + status + channel), the left properties column, the
 * thread, the composer, «Apply macro» (W8), and the resizable seam (W8/9.9 — the library's
 * Resizable since Шаг 1). The right context panel and the open-tickets tabs live in the SHELL's
 * slot (W10), not here.
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
  // «take it» needs to know who I am; until /me/operator answers the control simply is not there.
  const me = useMyOperator();
  // W8 — the composer's pickers (empty lists ⇒ the buttons do not render).
  const { macros, canned } = useTemplates();
  /**
   * W9 — the lookup key. ⛔ RENDER-only, as `permissionKeys` always is: hiding the box is a
   * courtesy so nobody meets a 403, and the refusal itself lives on the server (three tiers of it).
   */
  const session = useSession();
  const canLookUp =
    session.state.kind === 'authenticated' && session.state.permissionKeys.includes('crm.contact.lookup');
  /**
   * ⭐ 2026-08-10 — the Brand chooser's two inputs.
   *
   * `crm.conversation.set_brand` is a SUPERVISOR's key (R22: brand is read-only for agents), so the
   * field renders as a name for most people and as a chooser for the few. RENDER-only, as every
   * `permissionKeys` read on this screen is — the refusal itself is the server's, three tiers deep.
   *
   * ⚠️ The brand list is the ACCOUNT's own (`GET /brands`), never spelled in a screen: rule 6 — this
   * product carries no company's names in its code, and a hardcoded pair would be exactly that.
   */
  const canSetBrand =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('crm.conversation.set_brand');
  // ⭐ W27 / 036: the shelf verbs — RENDER-only like every permissionKeys read on this screen; the
  // refusal itself is the server's, at both tiers.
  const canShelve =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('crm.conversation.shelf.manage');
  const { brands } = useBrands();

  /**
   * ⭐ W10 — push the right rail into the SHELL's context-panel slot: the panel is a region of the
   * application, not a widget of this page (R27), which is what lets W11's directory reuse it.
   *
   * ⚠️ The slot stores a NODE, so it does not re-render when this window's state changes — the
   * component pushed is therefore self-contained (it owns its own hooks) and the effect re-pushes
   * only when the few identity facts it takes as props actually change. `clear()` on unmount, or
   * the panel would outlive the ticket and describe a customer nobody is looking at.
   */
  const { setPanel, clear } = useContextPanel();
  const detail = t.detail.status === 'ready' ? t.detail.data : null;
  const panelPlayerId = detail?.playerId ?? '';
  const panelBrandId = detail?.brandId ?? '';
  const panelIdentified = detail?.identityState === 'identified';
  useEffect(() => {
    setPanel(
      <TicketContextPanel
        playerId={panelPlayerId}
        brandId={panelBrandId}
        identified={panelIdentified}
        currentConversationId={id}
      />,
    );
    return () => clear();
  }, [setPanel, clear, panelPlayerId, panelBrandId, panelIdentified, id]);

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
            {/* ⭐ 2026-08-10 — the title is edited where it is read (operator: «название тикета тоже
                должно быть как placeholder… можно сделать placeholder без явных рамочек»). Naming a
                ticket LOCKS it against every automated writer (4.18 / FR-022), which is a property of
                the write and not of this control — the server owns it either way.
                ⓘ An open derivation window means the ticket genuinely has no subject YET; that is
                said as a state, never faked with the first message's text client-side. */}
            {/* ⭐ W24 (R43): the NUMBER comes FIRST — before the subject and the status. It used to
                trail the header after the channel; the operator: «в окне тикета номер стоит первым». */}
            {t.detail.data.reference && (
              <span className="shrink-0 font-mono text-lg text-muted-foreground" data-testid="ticket-reference">
                [{t.detail.data.reference}]
              </span>
            )}
            <h1 className="min-w-0 flex-1" data-testid="ticket-subject">
              <EditableText
                value={t.detail.data.subject}
                placeholder="No subject yet"
                onCommit={t.setSubject}
                disabled={t.mutation.status === 'busy'}
                ariaLabel="Ticket subject"
                testId="ticket-subject-edit"
                className="text-lg font-semibold"
              />
            </h1>
            <Badge variant="secondary" data-testid="ticket-status">
              {statusName(t.detail.data.statusKey)}
            </Badge>
            {t.detail.data.channel && (
              <span className="shrink-0 text-xs text-muted-foreground">via {t.detail.data.channel}</span>
            )}
            {/* ⭐ W27 / 036: the shelf verbs — supervision acts, offered only to holders of the
                manage key and only on an ORDINARY ticket (a shelved one gets the banner's verb). */}
            {canShelve && !t.detail.data.shelvedState && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="More actions"
                    title="More actions"
                    data-testid="ticket-more-actions"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-fast hover:bg-muted motion-reduce:transition-none"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" data-testid="ticket-more-menu">
                  <DropdownMenuItem
                    data-testid="ticket-suspend"
                    disabled={t.mutation.status === 'busy'}
                    onSelect={() => t.setShelf('suspended')}
                  >
                    Suspend ticket
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="ticket-delete"
                    disabled={t.mutation.status === 'busy'}
                    className="text-destructive focus:text-destructive"
                    onSelect={() => t.setShelf('deleted')}
                  >
                    Delete ticket
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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

      {/* ⭐ W27 / 036: the shelf banner — the ONE writable thing on a shelved ticket is the way back.
          Everything else on this screen still renders (the thread is readable through the bucket
          permission that got the person here), and every other write answers the server's refusal —
          the banner says so BEFORE someone types a reply that cannot be sent. */}
      {t.detail.status === 'ready' && t.detail.data.shelvedState && (
        <Alert
          variant={t.detail.data.shelvedState === 'deleted' ? 'destructive' : 'default'}
          className="mt-3 shrink-0"
          data-testid="shelf-banner"
        >
          <AlertTitle>
            {t.detail.data.shelvedState === 'deleted' ? 'Deleted (recoverable)' : 'Suspended'}
          </AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>
              {t.detail.data.shelvedState === 'deleted'
                ? 'Out of every list and queue until restored. Nothing is erased — the history and audit trail stay.'
                : 'Held out of every queue and list. It takes no replies and routes to nobody until released.'}
            </span>
            {canShelve && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="shelf-restore"
                disabled={t.mutation.status === 'busy'}
                onClick={() => t.setShelf('')}
              >
                {t.detail.data.shelvedState === 'deleted' ? 'Restore' : 'Release'}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Шаг 1 (9.9): the seam is the library's Resizable now — keyboard-draggable, focus-visible,
          layout persisted by its own `autoSaveId`. Constraints are PERCENTAGES, which is the
          project's own density rule (§0: proportions, never pixels) — the retired hand-made seam
          clamped pixels. During a drag only the panel wrappers re-render (the children are
          referentially stable), and the standing anti-storm assertion in the live check is the
          proof that holds this claim, same as it held the old one. */}
      <ResizablePanelGroup direction="horizontal" autoSaveId="crm.ticket.seam" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={25} minSize={15} maxSize={40} className="min-h-0">
          <FieldsColumn
            detail={t.detail}
            labels={t.labels}
            accountLabels={t.accountLabels}
            mutation={t.mutation}
            myOperatorId={me.operatorId ?? ''}
            canLookUp={canLookUp}
            brands={brands}
            canSetBrand={canSetBrand}
            onTakeIt={t.takeIt}
            onAttachLabel={t.attachLabel}
            onDetachLabel={t.detachLabel}
            onIdentityChanged={t.refresh}
            onSetStatus={t.setStatus}
            onSetPriority={t.setPriority}
            onSetBrand={t.setBrand}
            onSetAssignee={t.setAssignee}
            onSetPlayerId={t.setPlayerId}
          />
        </ResizablePanel>
        <ResizableHandle aria-label="Resize the properties column" data-testid="panel-divider" />

        <ResizablePanel defaultSize={75} className="min-h-0">
          <main className="flex h-full min-h-0 min-w-0 flex-col pl-3">
            <Thread state={t.thread} truncated={t.threadTruncated} onRetry={t.refresh} />
            <Composer
              send={t.send}
              sendState={t.sendState}
              statusOptions={submitStatuses}
              macros={macros}
              canned={canned}
              onApplyMacro={t.applyMacro}
            />
          </main>
        </ResizablePanel>

        {/* ⭐ W10: the right rail lives in the SHELL's slot (see the effect above), not in this
            row — one area of the application, per R27, so W11's directory can reuse it. */}
      </ResizablePanelGroup>
    </div>
  );
}
