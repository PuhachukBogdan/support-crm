'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import { useSession } from '@/session';
import type { AsyncState, DataError } from '@/data/types';

interface AssignmentWire {
  brandId?: string;
  playerId?: string;
}
interface ConversationWire {
  id?: string;
  subject?: string;
  statusKey?: string;
  playerId?: string;
  brandId?: string;
}
interface PortfolioRow {
  brandId: string;
  playerId: string;
}

/**
 * W17 — the VIP tab: the AM's own workspace (subpoints 4.4 + 4.5 + 4.6; roadmap 9.10/9.7 minimum).
 *
 * ── What it is ───────────────────────────────────────────────────────────────────────────────────
 * MY portfolio (`/me/players` — the subject is the session, nobody else can be named), each player
 * linking to their full card (W11's page), plus WRITE FIRST — the one outbound act the operator
 * named: one button, one channel (email). Below, MY tickets — the ordinary conversations list,
 * which the SERVER already narrows to the portfolio for an AM (feature 030), so this section is
 * "their players' tickets" by construction rather than by a second filter here.
 *
 * ── 4.5, the module rule ─────────────────────────────────────────────────────────────────────────
 * The rail contains this tab only for holders of `crm.vip.workspace` (assembled-from-permissions,
 * W13). This page ALSO render-gates on the key, so the typed URL answers with words rather than an
 * empty workspace — and the server refuses the initiate for a non-portfolio caller regardless.
 *
 * ── The write-first refusals are the server's, worded here ──────────────────────────────────────
 * "No known address" is the ordinary state until GR8 sync (5.4) exists: the product only knows
 * addresses players have written from. The form keeps the refusal beside itself and stays open.
 */
export function Vip() {
  const dataAccess = useDataAccess();
  const session = useSession();
  const permissionKeys = session.state.kind === 'authenticated' ? session.state.permissionKeys : [];
  const mayUse = permissionKeys.includes('crm.vip.workspace');

  const [portfolio, setPortfolio] = useState<AsyncState<PortfolioRow[]>>({ status: 'idle' });
  const [tickets, setTickets] = useState<ConversationWire[]>([]);

  useEffect(() => {
    if (!mayUse) return;
    let alive = true;
    setPortfolio({ status: 'loading' });
    void dataAccess
      .list<AssignmentWire>('my-players', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        const rows = page.items
          .filter((a): a is Required<AssignmentWire> => !!a?.brandId && !!a?.playerId)
          .map((a) => ({ brandId: a.brandId, playerId: a.playerId }));
        setPortfolio(rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows });
      })
      .catch((e) => alive && setPortfolio({ status: 'error', error: toDataError(e) }));

    // The list the server narrows for an AM — their players' tickets, no client-side filter needed.
    void dataAccess
      .list<ConversationWire>('conversations', { limit: 20, order: 'updated_desc' })
      .then((page) => alive && setTickets(page.items.filter((c) => !!c?.id)))
      .catch(() => alive && setTickets([]));

    return () => {
      alive = false;
    };
  }, [dataAccess, mayUse]);

  if (!mayUse) {
    return (
      <div className="mx-auto w-full max-w-3xl py-8">
        <p className="text-sm text-muted-foreground" data-testid="vip-not-available">
          The VIP workspace belongs to account managers. Your role does not hold it — and there is
          nothing here to switch on: the module is granted, never enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="VIP — my players" />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">My portfolio</h2>
        {portfolio.status === 'ready' ? (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="portfolio-list">
            {portfolio.data.map((p) => (
              <PlayerRow key={`${p.brandId}:${p.playerId}`} row={p} />
            ))}
          </ul>
        ) : portfolio.status === 'error' ? (
          <p className="text-sm text-destructive" data-testid="portfolio-error">
            {portfolio.error.message}
          </p>
        ) : portfolio.status === 'empty' ? (
          <p className="text-sm text-muted-foreground" data-testid="portfolio-empty">
            No players are attached to you yet. Attaching happens from a player's card or their
            ticket — a portfolio is built, not configured here.
          </p>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Their tickets</h2>
        {/* ⚠️ The narrowing is the SERVER's (feature 030): for an AM this list IS their players'
            tickets. A second filter here would be a client re-implementing an access rule. */}
        {tickets.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="vip-tickets">
            {tickets.map((t) => (
              <li key={t.id} className="p-2 text-sm">
                <Link href={`/tickets/${t.id}`} className="flex items-baseline gap-3 hover:underline">
                  <span className="min-w-0 flex-1 truncate">{t.subject || '—'}</span>
                  <span className="text-xs text-muted-foreground">{t.statusKey}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="vip-tickets-empty">
            No tickets from your players right now.
          </p>
        )}
      </section>
    </div>
  );
}

/** One attached player: the pair, the card link, and the write-first form. */
function PlayerRow({ row }: { row: PortfolioRow }) {
  const dataAccess = useDataAccess();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const [createdId, setCreatedId] = useState('');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await dataAccess.create<{ id?: string }>('initiate-email', {
        brandId: row.brandId,
        playerId: row.playerId,
        subject: subject.trim(),
        body: body.trim(),
      });
      setCreatedId(res?.id ?? '');
      setOpen(false);
      setSubject('');
      setBody('');
    } catch (e) {
      setError(toDataError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 p-3 text-sm" data-testid={`player-${row.brandId}-${row.playerId}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{row.playerId}</span>
        <span className="text-xs text-muted-foreground">{row.brandId}</span>
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/players/${encodeURIComponent(row.brandId)}/${encodeURIComponent(row.playerId)}`}>
              Open card
            </Link>
          </Button>
          <Button
            size="sm"
            data-testid={`write-first-${row.playerId}`}
            onClick={() => {
              setCreatedId('');
              setOpen((v) => !v);
            }}
          >
            {open ? 'Close' : 'Write first'}
          </Button>
        </span>
      </div>

      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            placeholder="Subject (optional — it becomes the ticket's title)"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            data-testid={`subject-${row.playerId}`}
          />
          <textarea
            required
            placeholder="The message. It goes to the address this player has written from before."
            className="min-h-20 w-full rounded-md border border-border bg-transparent p-2 text-sm"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            data-testid={`body-${row.playerId}`}
          />
          <Button type="submit" size="sm" disabled={busy || !body.trim()} data-testid={`send-first-${row.playerId}`}>
            Send
          </Button>
        </form>
      )}
      {createdId && (
        <p className="text-sm text-muted-foreground" data-testid={`initiated-${row.playerId}`}>
          Sent — the conversation exists and the mail is on its way.{' '}
          <Link href={`/tickets/${createdId}`} className="underline">
            Open the ticket
          </Link>
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" data-testid={`initiate-error-${row.playerId}`}>
          {error.message}
        </p>
      )}
    </li>
  );
}
