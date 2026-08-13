'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
// `BookOpen` is the left rail's Knowledge Base glyph — the same destination gets the same icon.
import { BookOpen, IdCard, ListChecks, type LucideIcon } from 'lucide-react';
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
/**
 * ⭐ **2026-08-10 — three panels, three ICONS, and the tab strip is gone.**
 *
 * The operator, looking at the built version: *«кнопки Knowledge Base и Active Tickets были помечены
 * не единичкой или двойкой, а соответствующими значками… чтобы они в самой боковой панельке, которая
 * выплывающая, чтобы их сверху не было, потому что тут они дублируют друг друга… Active Tickets…
 * должны быть отдельной иконкой справа, как Player Card и Knowledge Base… И она должна быть самой
 * первой.»*
 *
 * Three things were wrong and they were one thing: **Active tickets was a TAB while the other two
 * were RAIL BUTTONS**, so the panel had two competing controls for one question ("what am I looking
 * at"), and the tab strip re-stated whichever rail button was pressed. Promoting Active tickets to
 * the rail deletes the strip, the duplication and the special case together.
 *
 * `1` and `2` became icons for the reason the numbers were never good: a number is a position in a
 * list nobody sees. The Knowledge Base icon is the SAME one the left rail uses for its Knowledge Base
 * entry (`BookOpen`) — one destination, one glyph, wherever it appears.
 */
type PanelId = 'active' | 'player' | 'kb';

/** The rail, in the order the operator named. Data, so the order is a line rather than a layout. */
const PANELS: readonly { id: PanelId; label: string; icon: LucideIcon }[] = [
  // First, deliberately: it is the agent's own work (R17).
  { id: 'active', label: 'Active tickets', icon: ListChecks },
  { id: 'player', label: 'Player card', icon: IdCard },
  { id: 'kb', label: 'Knowledge base', icon: BookOpen },
];

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
  const [panel, setPanel] = useState<PanelId>('player');

  return (
    <div className="flex h-full min-h-0 gap-2" data-testid="ticket-context-panel">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No tab strip: the rail says which panel is open, and saying it twice was the complaint. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {panel === 'active' ? (
            <ActiveTickets currentConversationId={currentConversationId} />
          ) : panel === 'player' ? (
            <PlayerCard playerId={playerId} brandId={brandId} identified={identified} />
          ) : (
            <KnowledgePlaceholder />
          )}
        </div>
      </div>

      {/* The icon rail. Three buttons, and the absence of Zendesk's other three is a decision. */}
      <nav
        className="flex shrink-0 flex-col gap-1 border-l border-border pl-2"
        aria-label="Context panels"
      >
        {PANELS.map((p) => (
          <RailButton
            key={p.id}
            active={panel === p.id}
            onClick={() => setPanel(p.id)}
            testId={`rail-${p.id}`}
            label={p.label}
            icon={p.icon}
          />
        ))}
      </nav>
    </div>
  );
}

function RailButton({
  active,
  onClick,
  testId,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      // ⚠️ The label survives as `aria-label` and `title`: an icon-only control that names itself
      // nowhere is unreachable by a screen reader and a guess for everyone else.
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded ${
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden />
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
