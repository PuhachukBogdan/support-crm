'use client';

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { useSession } from '@/session';
import { relativeTime } from '@/features/inbox/wire-labels';
import type { DeniedAddressWire } from './types';
import { useDeniedAddresses } from './use-denied-addresses';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.10; FR-024…FR-034) — «Denied addresses»: the smallest
 * concrete control in the product, and the one with the sharpest edge.
 *
 * ── ⭐⭐ THE EMPTY STATE IS A MEANING, NOT AN ABSENCE ──────────────────────────────────────────────
 * An empty deny-list **refuses nobody**. One screen over, on `/admin/api-keys`, an empty address list
 * **permits nobody** — the same visual row, the same word «addresses», the opposite consequence
 * (FR-027). Nobody reads two screens carefully enough to notice that on their own, and the cost of
 * carrying the habit across is either «I banned the world» or «I banned nobody, and thought I had».
 * So both meanings are written out, here, in the words an administrator would use — in the header
 * where it is always visible, and in the empty state where the wrong habit would otherwise form.
 *
 * ── ⭐ The warning before the save (FR-034) ───────────────────────────────────────────────────────
 * The product genuinely does not know which address the administrator is connected from — the client
 * address is read at the boundary, for the boundary, and never travels to a screen. An honest warning
 * is therefore general: it names the consequence and who can undo it, and it is said BEFORE the write
 * rather than discovered after it, because after it there is no screen left to say it on.
 *
 * ── Everything else that makes this screen safe to use ───────────────────────────────────────────
 * • A repeat is a quiet success, said in words (`created: false`), never an error.
 * • The list shows the NORMALISED address the boundary compares, never the string that was typed.
 * • The gate is `platform.settings.manage`, refused in WORDS rather than as an empty table (the W28
 *   rule), and enforcement stays the server's — no interface decides this (FR-018/FR-024).
 */
export function DeniedAddresses() {
  const session = useSession();
  const mayManage =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('platform.settings.manage');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto py-2">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Denied addresses</h1>
        <p className="text-sm text-muted-foreground">
          Addresses the product refuses at the door — before a session is examined, on every route,
          including the ones that need no sign-in. Nothing adds an entry here except a person typing
          one: no lockout, no rate limit and no import can.
        </p>
        {/* ⭐ Always visible, not only when the list is empty: the habit this prevents is formed on a
            NON-empty list too, by somebody who read the API-keys screen last week. */}
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">
            An empty list here denies nobody.
          </strong>{' '}
          That is the opposite of the address list on an API key, where an empty list permits nobody.
          Both are lists of addresses, one screen apart, and they mean opposite things.
        </p>
      </header>

      {mayManage ? (
        <DenyList />
      ) : (
        <p
          className="rounded-md border border-border p-4 text-sm text-muted-foreground"
          data-testid="denied-denied"
        >
          Banning an address decides who can reach the product at all — including the people who work
          here — so it is an administrator’s task (
          <span className="font-mono">platform.settings.manage</span>), and this session does not hold
          it. Ask an administrator to add or lift the ban; the server refuses these calls from here
          regardless of what any screen shows.
        </p>
      )}
    </div>
  );
}

/** The editor and the notices ARRIVE — the «content entering» moment, on the motion tokens. */
const ENTER_CLASS =
  'animate-in fade-in-0 slide-in-from-top-1 duration-base ease-standard motion-reduce:animate-none';

function DenyList() {
  const d = useDeniedAddresses();
  const [adding, setAdding] = useState(false);
  const busy = d.busyKey !== null;

  return (
    <>
      {d.mutation && (
        <p className="text-sm text-destructive" data-testid="denied-mutation-error" role="alert">
          {d.mutation.message}
        </p>
      )}

      {/* ⭐ The quiet success. Neutral register on purpose: «nothing changed» is the right outcome
          here, and dressing it in the error colour would send somebody to fix a list that is right. */}
      {d.notice && (
        <Alert className={ENTER_CLASS} data-testid="denied-notice">
          <AlertTitle>Nothing changed — and that is the correct outcome</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{d.notice}</p>
            <Button size="sm" variant="outline" onClick={d.dismissNotice}>
              Got it
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Banned addresses</h2>
        {!adding && (
          <Button size="sm" data-testid="denied-new" disabled={busy} onClick={() => setAdding(true)}>
            Ban an address
          </Button>
        )}
      </div>

      {adding && (
        <AddressForm
          busy={busy}
          onSave={async (address, note) => {
            // A refusal keeps the editor open with their input; both successes close it, because in
            // both the list now holds what they asked for.
            if ((await d.add({ address, note })) !== 'refused') setAdding(false);
          }}
          onDone={() => setAdding(false)}
        />
      )}

      {d.addresses.status === 'loading' && <ListSkeleton />}
      {d.addresses.status === 'error' && <ErrorState error={d.addresses.error} onRetry={d.refresh} />}

      {/* ⭐ The meaningful empty state — an ANSWER to «who is banned?», not a report of no rows. */}
      {d.addresses.status === 'empty' && (
        <Empty className="border border-dashed border-border" data-testid="denied-empty">
          <EmptyHeader>
            <EmptyTitle>The list is empty — nobody is denied</EmptyTitle>
            <EmptyDescription>
              That is this list working, not this list unconfigured: an empty deny-list refuses
              nobody, and every address reaches the product as usual. ⚠️ Do not read it the way an
              API key’s address list reads — there, empty means nobody is allowed through. Here it
              means nobody is turned away.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {/* An invitation to act, and a REAL control — an empty state offering a button that does
                nothing is the placeholder failure this codebase already recorded once. */}
            <Button
              size="sm"
              data-testid="denied-empty-new"
              disabled={busy || adding}
              onClick={() => setAdding(true)}
            >
              Ban the first address
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {d.addresses.status === 'ready' && (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="denied-list"
        >
          {d.addresses.data.map((a) => (
            <AddressRow key={a.id} a={a} busy={busy} nameFor={d.nameFor} onRemove={d.remove} />
          ))}
        </ul>
      )}

      {/* ⚠️ Stated rather than left to be discovered: the gateway caches this list, so a ban is
          instant on the instance that saved it and takes up to about half a minute elsewhere
          (`services/gateway/src/network/denied-address.cache.ts`). An administrator who tests a ban
          from a second machine and sees it pass would otherwise conclude the control does not work. */}
      <p className="text-xs text-muted-foreground">
        A ban you save applies immediately here, and within about half a minute wherever else the
        product is running. Every add and every removal is written to the audit log against your name.
      </p>
    </>
  );
}

/** Skeleton in the SHAPE of the content (§4): rows, never a blank page or a spinner. */
function ListSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="space-y-px overflow-hidden rounded-md border border-border">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

function AddressRow({
  a,
  busy,
  nameFor,
  onRemove,
}: {
  a: DeniedAddressWire;
  busy: boolean;
  nameFor: (userId: string) => string;
  onRemove: (id: string, address: string) => void;
}) {
  const added = relativeTime(a.createdAt);
  return (
    <li className="flex flex-wrap items-start gap-3 p-3 text-sm" data-testid={`denied-${a.id}`}>
      <div className="min-w-0 flex-1 space-y-1">
        {/* Monospace, because an address is compared character by character and a proportional font
            hides the difference between what was meant and what was stored. */}
        <code className="block break-all font-mono font-medium text-foreground">{a.address}</code>
        <p className="text-sm text-muted-foreground">
          {a.note === '' ? <span className="italic">no note</span> : a.note}
        </p>
        <p className="text-xs text-muted-foreground">
          added by {nameFor(a.createdBy)}
          {' · '}
          {/* An absent or unparseable timestamp reads as «date not recorded», never as «just now». */}
          <span title={a.createdAt || undefined}>{added === '' ? 'date not recorded' : added}</span>
        </p>
      </div>

      <div className="flex shrink-0 gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid={`denied-remove-${a.id}`}
            >
              Lift the ban
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Let {a.address} through again?</AlertDialogTitle>
              <AlertDialogDescription>
                From the next request, this address reaches the product exactly like any other — the
                refusal stops at once here, and within about half a minute everywhere else. Nothing
                is erased: the removal is written to the audit log, and the address can be banned
                again at any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep the ban</AlertDialogCancel>
              <AlertDialogAction
                data-testid="denied-remove-confirm"
                onClick={() => onRemove(a.id, a.address)}
              >
                Lift the ban
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}

/**
 * The editor, and the one act on this screen that can lock its own author out.
 *
 * ⭐ Pressing «Ban this address» does NOT write: it opens the confirmation, which is where the
 * consequence is stated (FR-034). The order matters — a warning shown after the write would be an
 * apology, and on this particular act there may be no session left to read it with.
 */
function AddressForm({
  busy,
  onSave,
  onDone,
}: {
  busy: boolean;
  onSave: (address: string, note: string) => void;
  onDone: () => void;
}) {
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const trimmed = address.trim();
  const valid = trimmed !== '';

  return (
    <>
      <form
        className={`space-y-3 rounded-md border border-border p-3 ${ENTER_CLASS}`}
        data-testid="denied-form"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
        onSubmit={(e) => {
          // Enter in either field asks the question; it never performs the act (§4 keyboard floor).
          e.preventDefault();
          if (valid) setConfirming(true);
        }}
      >
        <div className="space-y-1">
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="The address to refuse — e.g. 203.0.113.10"
            aria-label="Address to deny"
            data-testid="denied-address"
            className="font-mono"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            One address, not a range and not a host name. It is stored in a single normalised form,
            so the same machine written two ways is banned once and matched always.
          </p>
        </div>

        <div className="space-y-1">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why — e.g. scanning the login page since Tuesday"
            aria-label="Note"
            data-testid="denied-note"
          />
          <p className="text-xs text-muted-foreground">
            Optional, and for people rather than for the product: in six months this is the only
            thing that explains why an address nobody remembers is on the list.
          </p>
        </div>

        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !valid} data-testid="denied-save">
            Ban this address
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>

        {/* Said while they are still typing, not only in the dialog — the short form of FR-034. */}
        <p className="text-xs text-muted-foreground">
          The refusal applies to everybody at that address, staff included, and it applies before
          sign-in — so it cannot be worked around by logging in.
        </p>
      </form>

      {/* ⚠️ A SIBLING of the form, never a child of it. Radix portals the content to the body, so
          the confirm button is not form-associated in the DOM — keeping it outside the form in the
          React tree too means no arrangement of portals and events can ever make «open the warning»
          and «perform the write» the same gesture. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refuse every request from {trimmed}?</AlertDialogTitle>
            <AlertDialogDescription>
              ⚠️ We cannot tell you whether that is the address you are connected from — the product
              reads the client address at the boundary and never shows it to a screen. If it is your
              own, you will lose access on your very next request, and the only person who can lift
              the ban afterwards is somebody who connects from a different address. Requests from it
              are refused before any session is looked at, on every route, including the ones that
              need no sign-in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="denied-cancel">Do not ban it</AlertDialogCancel>
            <AlertDialogAction
              data-testid="denied-confirm"
              onClick={() => onSave(trimmed, note.trim())}
            >
              Ban this address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
