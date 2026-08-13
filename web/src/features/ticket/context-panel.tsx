'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ComingSoonBadge } from '@/features/inbox/coming-soon';
import { relativeTime } from '@/features/inbox/wire-labels';
import { useActiveTickets } from './use-active-tickets';
import { usePlayerCard } from './use-player-card';

/**
 * W10 — the ticket window's right rail: **ONE consolidated area, not three widgets** (R27, the
 * operator's decision of 2026-08-04, which is also why W12 was folded into this block — building
 * the area twice would mean rewriting it).
 *
 * Its shape, from the operator's own verdicts on the Zendesk frames:
 *  · a narrow icon rail with exactly TWO buttons — `1` the player card, `2` the Knowledge Base;
 *    Zendesk's `3`/`4`/`5` (side conversations, approvals, apps) are **not built** — *«вообще не
 *    вижу смысла в этом»*, and the space they occupied is where the active-ticket list went;
 *  · an **Active tickets** tab above the content (R17 — the list he asked to put here);
 *  · the Knowledge Base button exists from day one and says it is empty (R19): the engine is
 *    post-MVP, and a button that lies about having content is worse than one that admits it.
 *
 * ⓘ It is pushed into the SHELL's context-panel slot (the first consumer of that slot), so the
 * panel is a region of the application rather than a widget inside the ticket page — which is what
 * "one area" has to mean structurally for W11's customer directory to reuse it.
 */
export function TicketContextPanel({
  playerId,
  brandId,
  identified,
  currentConversationId,
}: {
  playerId: string;
  brandId: string;
  identified: boolean;
  currentConversationId: string;
}) {
  const [tab, setTab] = useState<'active' | 'content'>('content');
  const [button, setButton] = useState<'player' | 'kb'>('player');

  return (
    <div className="flex h-full min-h-0 gap-2" data-testid="ticket-context-panel">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The tab strip: the agent's own work, above whichever panel is open. */}
        <div className="mb-2 flex shrink-0 gap-1 border-b border-border pb-2">
          <TabButton active={tab === 'content'} onClick={() => setTab('content')} testId="panel-tab-content">
            {button === 'player' ? 'Player' : 'Knowledge'}
          </TabButton>
          <TabButton active={tab === 'active'} onClick={() => setTab('active')} testId="panel-tab-active">
            Active tickets
          </TabButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'active' ? (
            <ActiveTickets currentConversationId={currentConversationId} />
          ) : button === 'player' ? (
            <PlayerCard playerId={playerId} brandId={brandId} identified={identified} />
          ) : (
            <KnowledgePlaceholder />
          )}
        </div>
      </div>

      {/* The icon rail. Two buttons, and the absence of the other three is a decision. */}
      <nav className="flex shrink-0 flex-col gap-1 border-l border-border pl-2" aria-label="Context panels">
        <RailButton
          active={tab === 'content' && button === 'player'}
          onClick={() => {
            setButton('player');
            setTab('content');
          }}
          testId="rail-player"
          label="Player card"
        >
          1
        </RailButton>
        <RailButton
          active={tab === 'content' && button === 'kb'}
          onClick={() => {
            setButton('kb');
            setTab('content');
          }}
          testId="rail-kb"
          label="Knowledge base"
        >
          2
        </RailButton>
      </nav>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
    >
      {children}
    </button>
  );
}

function RailButton({
  active,
  onClick,
  testId,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={`h-8 w-8 rounded text-sm ${active ? 'bg-muted font-semibold' : 'text-muted-foreground hover:bg-muted'}`}
    >
      {children}
    </button>
  );
}

/**
 * The player card. ⚠️ What it shows is decided by what the SERVER SENT, and every absence is
 * reported as an absence rather than filled in: the gateway drops proto defaults AND withholds
 * fields by role, so "not there" can mean either — and inventing a dash-that-looks-like-data would
 * make the two indistinguishable to the person reading it.
 */
function PlayerCard({
  playerId,
  brandId,
  identified,
}: {
  playerId: string;
  brandId: string;
  identified: boolean;
}) {
  const { player, history } = usePlayerCard(identified ? playerId : '', brandId);

  if (!identified) {
    return (
      <div className="space-y-2 text-sm" data-testid="player-card-unidentified">
        <p className="font-medium">No player attached</p>
        <p className="text-xs text-muted-foreground">
          This ticket has not been matched to a customer. Search by contact in the ticket’s
          Requester field to attach one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm" data-testid="player-card">
      {player.status === 'ready' ? (
        <div className="space-y-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Player</div>
            {/* ⓘ Not "name": the product stores none at any tier — it lives in GR8 (roadmap 5.4). */}
            <div className="font-mono">{player.data.playerId}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Brand</div>
            <div className="font-mono text-xs">{player.data.brandId}</div>
          </div>
          {player.data.vip && <Badge variant="secondary">VIP</Badge>}
          {player.data.segment && (
            <div>
              <div className="text-xs font-medium text-muted-foreground">Segment</div>
              <div>{player.data.segment}</div>
            </div>
          )}
        </div>
      ) : player.status === 'error' ? (
        <p className="text-xs text-destructive" data-testid="player-card-error">
          {player.error.message}
        </p>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}

      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Contact history</div>
        {history.status === 'ready' ? (
          <div className="space-y-1 text-xs" data-testid="contact-history">
            <div>
              Last contact:{' '}
              {history.data.lastContactAt ? relativeTime(history.data.lastContactAt) : 'never'}
            </div>
            <div>{history.data.conversationCount} conversations in total</div>
            <ul className="mt-1 space-y-0.5">
              {history.data.channels.map((c) => (
                <li key={c.channel || 'unrecorded'} className="flex justify-between gap-2">
                  <span>{c.channelUnrecorded ? 'unrecorded channel' : c.channel}</span>
                  <span className="text-muted-foreground">{c.conversationCount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : history.status === 'error' ? (
          // The history degrades ALONE — a failed count must not hide the identity on screen.
          <p className="text-xs text-muted-foreground">History is unavailable right now.</p>
        ) : (
          <Skeleton className="h-10 w-full" />
        )}
      </div>

      {/**
       * ⭐ The GR8 block. Nothing is behind it and the card SAYS so: balance, deposits, bonuses and
       * the rest arrive with the GR8 integration (roadmap 5.4). An empty area here would read as a
       * broken card; a labelled placeholder reads as a reserved one (the R13/R19 convention).
       */}
      <div data-testid="gr8-placeholder">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Player data (GR8)</span>
          <ComingSoonBadge />
        </div>
        <p className="text-xs text-muted-foreground">
          Balance, deposits and bonuses arrive with the GR8 integration. Nothing is hidden here —
          the product does not hold this data yet.
        </p>
      </div>
    </div>
  );
}

/** R19: the button exists from day one; the engine (post-MVP 10.5) does not, and it says so. */
function KnowledgePlaceholder() {
  return (
    <div className="space-y-2 text-sm" data-testid="kb-placeholder">
      <div className="flex items-center gap-2">
        <span className="font-medium">Knowledge base</span>
        <ComingSoonBadge />
      </div>
      <p className="text-xs text-muted-foreground">
        Articles will be written in the admin panel and suggested here. The authoring engine is not
        built yet.
      </p>
    </div>
  );
}

/** R17 — the agent's own open work, where the operator asked for it. */
function ActiveTickets({ currentConversationId }: { currentConversationId: string }) {
  const { items, loading } = useActiveTickets();
  const router = useRouter();

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="active-tickets-empty">
        Nothing open in your name yet. A ticket appears here once you open it.
      </p>
    );
  }

  return (
    <ul className="space-y-1" data-testid="active-tickets">
      {items.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => router.push(`/tickets/${encodeURIComponent(t.id)}`)}
            aria-current={t.id === currentConversationId ? 'true' : undefined}
            className={`w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted ${
              t.id === currentConversationId ? 'bg-muted font-medium' : ''
            }`}
          >
            {t.subject || 'No subject yet'}
          </button>
        </li>
      ))}
    </ul>
  );
}
