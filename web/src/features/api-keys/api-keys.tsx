'use client';

import { useEffect, useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { useSession } from '@/session';
import { relativeTime } from '@/features/inbox/wire-labels';
import { parseAddressList, type ApiKeyWire, type IssueApiKeyBody, type IssuedApiKeyWire } from './types';
import { useApiKeys } from './use-api-keys';

/**
 * ⭐ W31 (спек №2 / feature 038, roadmap 3.17; ADR 0043 §5) — «API keys»: the section where an
 * administrator issues the credential a machine calls us with, rotates it, and revokes it.
 *
 * ── ⭐ What this screen is actually FOR ───────────────────────────────────────────────────────────
 * A key that lives in a config file and never changes is a permanent shared secret with no owner.
 * This screen is what makes the credential operable instead: one key per named consumer, an address
 * list, a rate, and a lifecycle a person can drive without a developer (SC-001).
 *
 * ── ⚠️ The boundary this screen states OUT LOUD (the `channels.tsx` precedent) ────────────────────
 * The value is shown **once**, at the moment it is minted, and the product genuinely cannot show it
 * again: only a one-way hash is kept (FR-001). So the screen says so at issuance — not afterwards,
 * when it would only be an apology — and says the recovery too: a lost key is **rotated**, never
 * recovered. Nothing here offers a «show» or a «copy» that could imply otherwise; the value is text
 * a mouse can select, because a clipboard the product does not have would be a promise it cannot
 * keep.
 *
 * Authoring rides `platform.settings.manage` (contracts §B); a session without it gets the refusal
 * IN WORDS — the same sentence the server's 403 means, said before a screen that cannot save. The
 * gate short-circuits every read too: a 403 storm is not a render strategy (the W28 rule).
 * Enforcement is still the server's — FR-004 is explicit that no interface decides this.
 */
export function ApiKeys() {
  const session = useSession();
  const mayManage =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('platform.settings.manage');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto py-2">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">API keys</h1>
        <p className="text-sm text-muted-foreground">
          The credentials other systems call us with — one key per named consumer, each with the
          addresses it may call from and how often. A key’s value is shown once, when it is issued.
        </p>
      </header>

      {mayManage ? (
        <KeyManagement />
      ) : (
        <p
          className="rounded-md border border-border p-4 text-sm text-muted-foreground"
          data-testid="keys-denied"
        >
          An API key can create and deactivate staff accounts, so issuing one is an administrator’s
          task (<span className="font-mono">platform.settings.manage</span>), and this session does
          not hold it. Ask an administrator to issue the key and hand you its value — they see it
          once too.
        </p>
      )}
    </div>
  );
}

/** The inline editor and the value panel ARRIVE — two of the four motion moments, on the tokens. */
const ENTER_CLASS =
  'animate-in fade-in-0 slide-in-from-top-1 duration-base ease-standard motion-reduce:animate-none';

function KeyManagement() {
  const a = useApiKeys();
  const [creating, setCreating] = useState(false);
  const busy = a.busyKey !== null;

  return (
    <>
      {/* ⭐ The value panel sits ABOVE everything: it is the one thing on this screen that expires,
          and an administrator who has to scroll to find it is an administrator who loses a key. */}
      {a.issued && <IssuedValue issued={a.issued} onDismiss={a.dismissIssued} />}

      {a.mutation && (
        <p className="text-sm text-destructive" data-testid="keys-mutation-error" role="alert">
          {a.mutation.message}
        </p>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Issued keys</h2>
        {!creating && (
          <Button size="sm" data-testid="key-new" disabled={busy} onClick={() => setCreating(true)}>
            New key
          </Button>
        )}
      </div>

      {creating && (
        <KeyForm
          busy={busy}
          onSave={async (body) => {
            if (await a.issue(body)) setCreating(false);
          }}
          onDone={() => setCreating(false)}
        />
      )}

      {a.keys.status === 'loading' && <KeysSkeleton />}
      {a.keys.status === 'error' && <ErrorState error={a.keys.error} onRetry={a.refresh} />}
      {a.keys.status === 'empty' && (
        <p className="text-sm text-muted-foreground" data-testid="keys-empty">
          No keys yet. Nothing outside this product can call it until one exists — issue the first
          for whichever system needs it (the HR platform is the one this was built for), name the
          addresses it calls from, and hand its value over once.
        </p>
      )}
      {a.keys.status === 'ready' && (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="keys-list">
          {a.keys.data.map((k) => (
            <KeyRow key={k.id} k={k} busy={busy} onRotate={a.rotate} onRevoke={a.revoke} />
          ))}
        </ul>
      )}
    </>
  );
}

/** Skeleton in the SHAPE of the content (§4): a header row, then key rows — never a blank. */
function KeysSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="space-y-px overflow-hidden rounded-md border border-border">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * ⭐ The value, once. Everything about this panel is the one-shot rule made visible: it is the
 * loudest thing on the screen, it states the consequence before the administrator can lose it, and
 * dismissing it DROPS the value (see `use-api-keys.ts`) rather than hiding it.
 *
 * ⓘ No copy button on purpose — the product has no clipboard integration, and a button that
 * silently failed would be worse than the selectable text it replaced. `select-all` makes one click
 * take the whole value.
 */
function IssuedValue({ issued, onDismiss }: { issued: IssuedApiKeyWire; onDismiss: () => void }) {
  // Esc closes it, like every other transient surface on the product (§4 keyboard floor). A window
  // listener rather than a handler on the node: the panel is not what holds focus after a save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // `Alert` already carries `role="alert"`, which is the right register here: a value that expires
  // when the panel closes is exactly the announcement a screen reader must not defer.
  return (
    <Alert className={`border-primary bg-muted ${ENTER_CLASS}`} data-testid="key-value-panel">
      <AlertTitle>The key for «{issued.key.consumer}» — shown once, here, now</AlertTitle>
      <AlertDescription className="space-y-3">
        <code
          className="block select-all break-all rounded-md border border-border bg-background p-3 font-mono text-sm text-foreground"
          data-testid="key-value"
        >
          {issued.value}
        </code>
        <p>
          Save it somewhere safe before you close this. We will not show it again and we cannot: only
          a one-way hash of it is stored, so nothing in the product can read it back. A key that gets
          lost is not recovered — it is rotated, which mints a new value and stops this one.
        </p>
        <Button size="sm" data-testid="key-value-dismiss" onClick={onDismiss}>
          I have saved it
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function KeyRow({
  k,
  busy,
  onRotate,
  onRevoke,
}: {
  k: ApiKeyWire;
  busy: boolean;
  onRotate: (id: string) => void;
  onRevoke: (id: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-start gap-3 p-3 text-sm" data-testid={`key-${k.id}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`truncate font-medium ${k.active ? '' : 'text-muted-foreground'}`}>
            {k.consumer}
          </span>
          <Badge variant={k.active ? 'outline' : 'secondary'}>{k.active ? 'active' : 'revoked'}</Badge>
          {/* Truthiness, not `!== ''`: a server that omits the member entirely must not read as
              «this key replaced another one» — the badge is a claim about lineage. */}
          {k.rotatedFromId ? <Badge variant="outline">rotated</Badge> : null}
        </div>

        {/* The fingerprint is the key's public name — it is what every journal entry carries, so it
            is what an administrator matches an audit line against (FR-005). */}
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">{k.fingerprint}</code>
        </p>

        <p className="text-xs text-muted-foreground">
          {k.ipAllowList.length === 0 ? (
            // ⚠️ Fail-closed, and said rather than left to be discovered: an empty list is «nobody».
            <span className="text-destructive">
              no addresses — every call with this key is refused
            </span>
          ) : (
            <>from {k.ipAllowList.join(', ')}</>
          )}
          {' · '}
          {k.ratePerHour} call{k.ratePerHour === 1 ? '' : 's'} per hour
          {' · '}
          {/* Same rule: an absent or unparseable timestamp is «never used», never «last used ». */}
          {relativeTime(k.lastUsedAt ?? '') === ''
            ? 'never used'
            : `last used ${relativeTime(k.lastUsedAt)}`}
        </p>
      </div>

      {/* A revoked key has nothing left to do TO it: the row stays for the journal, and offering
          acts that would be refused is the control-that-does-nothing shape. */}
      {k.active && (
        <div className="flex shrink-0 gap-2">
          <ConfirmAct
            triggerTestId={`key-rotate-${k.id}`}
            confirmTestId="key-rotate-confirm"
            label="Rotate"
            busy={busy}
            title={`Rotate the key for «${k.consumer}»?`}
            description={`A new value is minted and shown once, here. The current value stops working immediately — the very next call signed with it is refused, so whoever calls us needs the new value before then. Both acts go into the journal against fingerprint ${k.fingerprint}.`}
            onConfirm={() => onRotate(k.id)}
          />
          <ConfirmAct
            triggerTestId={`key-revoke-${k.id}`}
            confirmTestId="key-revoke-confirm"
            label="Revoke"
            busy={busy}
            destructive
            title={`Revoke the key for «${k.consumer}»?`}
            description={`The very next call with it is refused, and there is no undo — a revoked key is never re-enabled, a replacement is issued. Nothing is erased: the key’s record and its journal stay, so the history of what it did remains readable.`}
            onConfirm={() => onRevoke(k.id)}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The two consequential acts ask first, IN WORDS, and each description states the consequence as a
 * prediction rather than a warning — «the very next call is refused», not «this is dangerous».
 * Alert Dialog from the library, never a hand-made overlay (rule 11's library-first rule).
 */
function ConfirmAct({
  triggerTestId,
  confirmTestId,
  label,
  title,
  description,
  busy,
  destructive,
  onConfirm,
}: {
  triggerTestId: string;
  confirmTestId: string;
  label: string;
  title: string;
  description: string;
  busy: boolean;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={destructive ? 'destructive' : 'outline'}
          disabled={busy}
          data-testid={triggerTestId}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it as it is</AlertDialogCancel>
          <AlertDialogAction data-testid={confirmTestId} onClick={onConfirm}>
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The default hourly rate. A cap has to be a number, and a number nobody chose is still a policy. */
const DEFAULT_RATE = 60;

function KeyForm({
  busy,
  onSave,
  onDone,
}: {
  busy: boolean;
  onSave: (body: IssueApiKeyBody) => void;
  onDone: () => void;
}) {
  const [consumer, setConsumer] = useState('');
  const [addresses, setAddresses] = useState('');
  const [rate, setRate] = useState(String(DEFAULT_RATE));

  const ipAllowList = parseAddressList(addresses);
  const ratePerHour = Number.parseInt(rate, 10);
  const valid = consumer.trim() !== '' && Number.isFinite(ratePerHour) && ratePerHour > 0;

  return (
    <form
      className={`space-y-3 rounded-md border border-border p-3 ${ENTER_CLASS}`}
      data-testid="key-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
      onSubmit={(e) => {
        // Enter in any field submits — the form is three fields and one obvious act (§4 keyboard).
        e.preventDefault();
        if (valid) onSave({ consumer: consumer.trim(), ipAllowList, ratePerHour });
      }}
    >
      <Input
        value={consumer}
        onChange={(e) => setConsumer(e.target.value)}
        placeholder="Who calls us — e.g. HR platform"
        aria-label="Consumer name"
        data-testid="key-consumer"
        autoFocus
      />

      <div className="space-y-1">
        <Input
          value={addresses}
          onChange={(e) => setAddresses(e.target.value)}
          placeholder="Addresses allowed to use it — 203.0.113.10, 198.51.100.7"
          aria-label="Allowed addresses"
          data-testid="key-ips"
        />
        <p className="text-xs text-muted-foreground">
          {ipAllowList.length === 0
            ? 'Left empty, this key refuses every call — an empty list means nobody, never anybody. That is a usable state for preparing a key ahead of time; add the address before the first call.'
            : `${ipAllowList.length} address${ipAllowList.length === 1 ? '' : 'es'} — a call from anywhere else is refused before anything is created.`}
        </p>
      </div>

      <div className="space-y-1">
        <Input
          type="number"
          min={1}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder="Calls per hour"
          aria-label="Calls per hour"
          data-testid="key-rate"
          className="w-40"
        />
        <p className="text-xs text-muted-foreground">
          Calls per hour. Everything past it is refused with «too many» and is journalled like any
          other refusal — a burst is visible rather than silent.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} data-testid="key-save">
          Issue key
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {/* Said BEFORE the act, not after it — the moment the value exists is too late to warn. */}
      <p className="text-xs text-muted-foreground">
        Issuing shows the value once, on this screen. Have somewhere to put it open before you press.
      </p>
    </form>
  );
}
