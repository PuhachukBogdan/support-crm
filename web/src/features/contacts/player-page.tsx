'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { ComingSoonBadge } from '@/features/inbox/coming-soon';
import { relativeTime } from '@/features/inbox/wire-labels';
import { usePlayerCard } from '@/features/ticket/use-player-card';
import { PlayerNotes } from '@/features/ticket/player-notes';

/**
 * W11 — the full player page (roadmap 9.17's second half): *«просто расширенная карточка»*.
 *
 * ⚠️ It reuses the PANEL's reads verbatim (`usePlayerCard`) rather than writing its own. The two
 * surfaces must never disagree about the same customer, and a second read path is how they would:
 * one of them would be updated and the other forgotten. What differs is the LAYOUT, which is all
 * the operator asked to differ.
 *
 * ⛔ Deliberately not here: the ticket / related / security TABS the reference mentions. The feed
 * exists server-side, the "related" read has no route yet, and "security" has no concept at all —
 * three tabs where two would be empty is a screen that lies about being finished. They arrive with
 * the reads that fill them.
 */
export function PlayerPage({ brandId, playerId }: { brandId: string; playerId: string }) {
  const { player, history } = usePlayerCard(playerId, brandId);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto">
      <div className="flex items-center gap-3">
        <Link href="/contacts" className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted">
          ← Customers
        </Link>
        <PageHeader title="Customer" />
      </div>

      {player.status === 'ready' ? (
        <section className="space-y-3 rounded-md border border-border p-4" data-testid="player-page-identity">
          <div className="flex flex-wrap items-center gap-3">
            {/* The id IS the identity here — the product holds no name at any tier (research R9). */}
            <span className="font-mono text-lg">{player.data.playerId}</span>
            {player.data.vip && <Badge variant="secondary">VIP</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Fact label="Brand" value={player.data.brandId} mono />
            {player.data.segment !== undefined && <Fact label="Segment" value={player.data.segment} />}
            {player.data.personId !== undefined && <Fact label="Person" value={player.data.personId} mono />}
          </dl>
          {/* ⚠️ Fields the caller's tier withholds are ABSENT above, not blank — proven on the wire
              in W10's live round. The page therefore shows fewer rows for a narrower role rather
              than a column of dashes that would read as missing data. */}
        </section>
      ) : player.status === 'error' ? (
        <ErrorState error={player.error} />
      ) : (
        <Skeleton className="h-32 w-full" />
      )}

      <section className="space-y-2 rounded-md border border-border p-4">
        <h2 className="text-sm font-medium">Contact history</h2>
        {history.status === 'ready' ? (
          <div className="space-y-1 text-sm" data-testid="player-page-history">
            <div>
              Last contact:{' '}
              {history.data.lastContactAt ? relativeTime(history.data.lastContactAt) : 'never'}
            </div>
            <div>{history.data.conversationCount} conversations in total</div>
            <ul className="mt-2 space-y-1 text-xs">
              {history.data.channels.map((c) => (
                <li key={c.channel || 'unrecorded'} className="flex max-w-sm justify-between gap-4">
                  <span>{c.channelUnrecorded ? 'unrecorded channel' : c.channel}</span>
                  <span className="text-muted-foreground">{c.conversationCount}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : history.status === 'error' ? (
          <p className="text-xs text-muted-foreground">History is unavailable right now.</p>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </section>

      {/**
       * ⭐ W35 (R35 · U17) — Manager notes. The SAME component and hook the ticket window's card mounts,
       * per this file's own rule one screen up: the two surfaces must never disagree about the same
       * customer. Only the `variant` differs, which is all that legitimately differs — the panel is a
       * 320px drawer and this is a page.
       */}
      <PlayerNotes playerId={playerId} brandId={brandId} variant="page" />

      <section className="space-y-2 rounded-md border border-border p-4" data-testid="player-page-gr8">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Player data (GR8)</h2>
          <ComingSoonBadge />
        </div>
        <p className="text-xs text-muted-foreground">
          Balance, deposits, bonuses and risk data arrive with the GR8 integration. Nothing is
          hidden here — the product does not hold this data yet.
        </p>
      </section>
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-xs' : ''}`}>{value || '—'}</dd>
    </div>
  );
}
