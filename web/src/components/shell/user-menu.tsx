'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useDataAccess } from '@/data/provider';
import { uploadThumbUrl } from '@/data/asset-url';
import { PRESENCE_CHOICES, PRESENCE_TONE, type PresenceChoice } from '@/data/presence';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * W22 — the user menu, in the rail's FOOTER (R40).
 *
 * ── Why it exists at all, and why here ───────────────────────────────────────────────────────────
 * The operator, on his reference frame `topbar/030`: *«это, по сути, вообще окно юзера… как минимум
 * там можно выставить свой статус, перейти в настройки своего аккаунта»*, present on **every** screen
 * and for **every** role — *«не только саппорта, но и VIP-менеджера, и админа»*. He weighed top-right
 * against bottom-left and chose **bottom-left**, with a separate settings button beside it.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────────
 * ⛔ **Sign-out.** It moved to account settings on his instruction — *«в той всплывающей панели… это
 * как-то слишком легко. Разлогиниться можно, но в этом особого смысла нет, потому что никто logout
 * часто делать не будет»*. ⚠️ The property that control carries — a sign-out ends the session **on
 * the server**, not by flipping a local flag — moved WITH it and is asserted where it now lives
 * (`settings.test.tsx`). A check that quietly stays behind when its subject moves is how a guarantee
 * evaporates while every file still looks right (the W8 lesson, third instance).
 * ⛔ **Theme.** Also gone from the chrome, into settings (R40).
 *
 * ── Presence: four states, and they already existed ──────────────────────────────────────────────
 * The server's closed set is `online · transfers_only · away · offline` (feature 025, and the gateway
 * decodes exactly these four). The product had been offering **two of them** — «On shift» / «Break»
 * on the settings page — so this is not new capability, it is capability that had no control. The
 * router (031) reads the same store, which is what makes *«на перерыве — тикеты не приходят»* one
 * fact rather than two.
 */
interface OperatorWire {
  operatorId?: string;
  displayName?: string;
  avatarUploadId?: string;
}
interface PresenceWire {
  state?: string;
}

/**
 * ⓘ The four states and their tones live in `@/data/presence` — the ticket window's Assignee chooser
 * needs the same vocabulary, and a second copy of a closed set is how the two drift apart.
 */
const TONE = PRESENCE_TONE;

export function UserMenu() {
  const dataAccess = useDataAccess();
  const [operator, setOperator] = useState<OperatorWire | null>(null);
  const [presence, setPresence] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .get<OperatorWire>('me-operator', '')
      .then((res) => alive && setOperator(res))
      .catch(() => alive && setOperator({}));
    void dataAccess
      .get<PresenceWire>('my-presence', '')
      .then((res) => alive && setPresence(res?.state ?? ''))
      .catch(() => alive && setPresence(''));
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  /**
   * ⚠️ The optimistic write is deliberate and bounded: the badge changes at once, and a failure puts
   * the previous state back. Presence decides whether work reaches this person, so a control that
   * silently kept its old value would be the worst kind of lie here.
   */
  const choose = useCallback(
    async (state: PresenceChoice) => {
      const previous = presence;
      setPresence(state);
      setBusy(true);
      try {
        await dataAccess.update('my-presence', '', { state });
      } catch {
        setPresence(previous);
      } finally {
        setBusy(false);
      }
    },
    [dataAccess, presence],
  );

  const avatarId = operator?.avatarUploadId ?? '';
  const name = operator?.displayName ?? '';
  const current = PRESENCE_CHOICES.find((c) => c.state === presence);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="user-menu-trigger"
          aria-label={`Your account${current ? ` — ${current.label}` : ''}`}
          className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent"
        >
          {avatarId ? (
            <img
              src={uploadThumbUrl(avatarId)}
              alt=""
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {(name || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
          {/* The state is readable without opening anything — the point of putting it here. */}
          <span
            data-testid="presence-dot"
            data-state={presence || 'unknown'}
            className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card ${
              TONE[presence] ?? 'bg-muted-foreground'
            }`}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="right" align="end" className="w-56" data-testid="user-menu">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{name || 'Signed in'}</div>
          <div className="text-xs text-muted-foreground">{current?.hint ?? 'Status unknown'}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESENCE_CHOICES.map((c) => (
          <DropdownMenuItem
            key={c.state}
            disabled={busy}
            data-testid={`presence-${c.state}`}
            aria-current={presence === c.state ? 'true' : undefined}
            onSelect={() => void choose(c.state)}
            className="gap-2"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[c.state]}`} />
            <span className="flex-1">{c.label}</span>
            {presence === c.state && <span className="text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings" data-testid="user-menu-settings">
            Settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
