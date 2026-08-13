'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
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
import { PanelDivider, useStoredPanelWidth } from './panel-divider';
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
  const { brands } = useBrands();
  // W8 (9.9) — the left column's width: a live CSS value during the drag, a stored number after it.
  const fields = useStoredPanelWidth();

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

      <div className="flex min-h-0 flex-1">
        {/* 9.9: the wrapper owns the WIDTH so the drag writes one style property on one element —
            never a React render per pixel (the anti-storm rule, applied before it is needed). */}
        <div ref={fields.ref} style={{ width: fields.width }} className="min-h-0 shrink-0">
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
        </div>
        <PanelDivider target={fields} />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col pl-3">
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

        {/* ⭐ W10: the right rail lives in the SHELL's slot (see the effect above), not in this
            row — one area of the application, per R27, so W11's directory can reuse it. */}
      </div>
    </div>
  );
}
