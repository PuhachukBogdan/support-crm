'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { useSession } from '@/session';
import {
  factOrigin,
  factState,
  groupBySeverity,
  type FactGroup,
  type SecurityFactWire,
} from './types';
import { useSecurityPosture } from './use-security-posture';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.11; FR-017…FR-023) — «Security posture»: the one page in
 * the product where being WRONG is worse than being absent.
 *
 * ── ⭐⭐ The two things this screen exists to make visible ────────────────────────────────────────
 * A hand-typed checklist and a live read are **indistinguishable by eye** — that is the whole reason
 * the cheap version of this page is dangerous, and why the honesty has to be visible rather than
 * promised. So the rendering carries the two distinctions the data carries:
 *
 *  1. **ORIGIN.** A fact `built_in` is a property of the product — masking, the emailed code, an
 *     empty allow-list denying everything. It is rendered as «built into the product» and ⛔ never as
 *     a control that happens to be switched on: there is no switch, and a row that looked like one
 *     would promise a control panel that does not exist. Its «ok» is a formality of the wire, not a
 *     check that ran, so it is not shown as one either.
 *  2. **STATE.** `unknown` — an unreachable service, a query that threw — is shown LOUDLY and never
 *     as a pass. «A missing protection and an unreachable service must not look alike», and an
 *     administrator reading «in order» about a control nobody could verify is the false assurance the
 *     whole page is built to avoid. Anything this build cannot classify lands in `unknown` too
 *     (`types.ts`), which is the cautious end on purpose.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────────
 * ⛔ No key value, no secret, no address, no contact value — the server sends none (FR-019), and this
 * screen adds nothing of its own: every line on it is a `label`, a `value` and a `note` that arrived.
 * ⛔ No toggles. Nothing here is editable; a posture page that could change a protection would be a
 * settings screen wearing a report's clothes, and its numbers would describe its own writes.
 * ⛔ No fact keys in the code. Adding a fact is adding a row in a SERVICE's registry (FR-023).
 */
export function SecurityPosture() {
  const session = useSession();
  const mayManage =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('platform.settings.manage');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto py-2">
      {mayManage ? (
        <Posture />
      ) : (
        <>
          <header>
            <h1 className="text-lg font-semibold tracking-tight">Security posture</h1>
          </header>
          <p
            className="rounded-md border border-border p-4 text-sm text-muted-foreground"
            data-testid="security-denied"
          >
            This page states what protects the whole account and where it is weak, which is an
            administrator’s read (<span className="font-mono">platform.settings.manage</span>), and
            this session does not hold it. Ask an administrator to look. The server refuses the data
            behind this page to you as well — nothing here is decided by what a screen renders.
          </p>
        </>
      )}
    </div>
  );
}

function Posture() {
  const { posture, refresh } = useSecurityPosture();
  const facts = posture.status === 'ready' ? posture.data.facts : [];
  const unreadable = facts.filter((f) => factState(f.state) === 'unknown').length;
  const needAttention = facts.filter((f) => factState(f.state) === 'attention').length;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Security posture</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every line below is read from the system at the moment you open this page — none of it is
            a checklist somebody typed. Change the thing a line describes, reload, and the line
            changes with it.
          </p>
          {posture.status === 'ready' && (
            <p className="text-xs text-muted-foreground" data-testid="security-generated-at">
              Read at {formatTime(posture.data.generatedAt)}
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" data-testid="security-refresh" onClick={refresh}>
          Read again
        </Button>
      </header>

      {posture.status === 'loading' && <PostureSkeleton />}
      {posture.status === 'error' && <ErrorState error={posture.error} onRetry={refresh} />}

      {/* ⚠️ No facts at all is NOT a clean bill of health, and this is the one place that could be
          mistaken for one. An empty posture means nothing could be established. */}
      {posture.status === 'empty' && (
        <Empty className="border border-dashed border-border" data-testid="security-empty">
          <EmptyHeader>
            <EmptyTitle>Nothing could be read — this is not a clean result</EmptyTitle>
            <EmptyDescription>
              No service answered with a single fact. That says nothing about whether the account’s
              protections are in place; it says they could not be checked. Read again in a moment,
              and if the page stays empty, the services behind it are the thing to look at.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {posture.status === 'ready' && (
        <>
          <Summary unreadable={unreadable} needAttention={needAttention} total={facts.length} />
          <Legend />
          {groupBySeverity(facts).map((group) => (
            <SeverityGroup key={group.severity} group={group} />
          ))}
        </>
      )}
    </>
  );
}

/** Skeleton in the SHAPE of the page: a summary strip, then grouped rows (§4). */
function PostureSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-16 w-full" />
      <div className="space-y-px overflow-hidden rounded-md border border-border">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * The one sentence an administrator should be able to leave with.
 *
 * ⚠️ The unreadable count outranks everything else, including facts that need attention: a page whose
 * headline is «3 need a look» while four others could not be read has quietly reported an outage as a
 * short checklist.
 */
function Summary({
  unreadable,
  needAttention,
  total,
}: {
  unreadable: number;
  needAttention: number;
  total: number;
}) {
  if (unreadable > 0) {
    return (
      <Alert variant="destructive" data-testid="security-summary" data-summary="unreadable">
        <AlertTitle>
          {unreadable} of {total} could not be read
        </AlertTitle>
        <AlertDescription>
          An unread check is not a passed check. Whatever those lines describe may be in place or may
          not — nothing here knows, and nothing on this page will pretend otherwise. They are marked
          «not checked» below.
          {needAttention > 0 && ` A further ${needAttention} asked for your attention.`}
        </AlertDescription>
      </Alert>
    );
  }

  if (needAttention > 0) {
    return (
      <Alert data-testid="security-summary" data-summary="attention">
        <AlertTitle>
          {needAttention} of {total} ask for your attention
        </AlertTitle>
        <AlertDescription>
          Everything else was read and came back as expected. The lines below say what each one found
          and what it means — none of them is an error, and none needs an answer today unless it says
          so.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert data-testid="security-summary" data-summary="clear">
      {/* ⚠️ «arrived», not «were read»: some of these are built-in properties rather than queries,
          and this page does not get to overstate its own thoroughness in its headline. */}
      <AlertTitle>All {total} arrived, and none asks for anything</AlertTitle>
      <AlertDescription>
        Each line below came either from a query run in this request or from a property of the
        product itself, and each says which. Nothing here was assumed.
      </AlertDescription>
    </Alert>
  );
}

/** The vocabulary, once, so the badges below need no explaining twice. */
function Legend() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="security-legend">
      <strong className="font-medium text-foreground">read</strong> — the value came from a query
      just now · <strong className="font-medium text-foreground">built into the product</strong> — a
      property of how the product works, not a setting, and there is no switch for it ·{' '}
      <strong className="font-medium text-foreground">not checked</strong> — nobody could establish
      this one, which is never the same as «in order».
    </p>
  );
}

const GROUP_LABEL: Record<string, string> = {
  unrecognised: 'Not classified by this version',
  critical: 'Critical',
  recommended: 'Recommended',
  informational: 'Informational',
};

const GROUP_BLURB: Record<string, string> = {
  unrecognised:
    'A service rated these in a word this build does not know. They are shown first and unrated rather than guessed at — a fact nobody could classify is not a fact that can be filed under «informational».',
  critical: 'Worth acting on. A departure here changes who can reach what.',
  recommended: 'Worth knowing. These describe how much of a protection is actually in use.',
  informational: 'Context. Nothing here is wrong by being a particular number.',
};

function SeverityGroup({ group }: { group: FactGroup }) {
  return (
    <section className="space-y-2" data-testid={`severity-${group.severity}`}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium">{GROUP_LABEL[group.severity] ?? group.severity}</h2>
        <span className="text-xs text-muted-foreground">{group.facts.length}</span>
      </div>
      <p className="text-xs text-muted-foreground">{GROUP_BLURB[group.severity] ?? ''}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {group.facts.map((f) => (
          <FactRow key={f.key} fact={f} />
        ))}
      </ul>
    </section>
  );
}

/** Words first, colour second — every distinction on this page survives a monochrome screenshot. */
const STATE_LABEL: Record<string, string> = {
  ok: 'in order',
  attention: 'needs a look',
  unknown: 'not checked',
};

const STATE_TONE: Record<string, string> = {
  // Muted rather than green: a page of green badges reads as decoration, and «in order» is the
  // unremarkable case. What must stand out is everything else.
  ok: 'border-transparent bg-muted text-muted-foreground',
  attention: 'border-transparent bg-warning text-warning-foreground',
  // ⚠️ The loudest tone on the page belongs to «not checked», not to «needs a look». A fact somebody
  // must look at is a normal state of a system; a fact nobody could establish is the state in which
  // this page could be lying to them.
  unknown: 'border-transparent bg-destructive text-destructive-foreground',
};

function FactRow({ fact }: { fact: SecurityFactWire }) {
  const state = factState(fact.state);
  const origin = factOrigin(fact.kind);
  // ⭐ A built-in fact's «ok» is a formality of the wire, not a check that ran — so it is not shown
  // as one. The origin badge is the whole claim, and it says «built in», never «switched on».
  const showState = origin !== 'built_in' || state !== 'ok';

  return (
    <li
      className="flex flex-wrap items-start gap-3 p-3 text-sm"
      data-testid={`fact-row-${fact.key}`}
      data-state={state}
      data-origin={origin}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{fact.label}</span>
          {showState && (
            <Badge className={STATE_TONE[state]} data-testid={`fact-state-${fact.key}`}>
              {STATE_LABEL[state]}
            </Badge>
          )}
          <OriginBadge origin={origin} factKey={fact.key} />
        </div>

        <p
          className={
            state === 'unknown' ? 'text-sm font-medium text-destructive' : 'text-sm text-foreground'
          }
          data-testid={`fact-value-${fact.key}`}
        >
          {fact.value}
        </p>

        {fact.note ? <p className="text-xs text-muted-foreground">{fact.note}</p> : null}
      </div>
    </li>
  );
}

function OriginBadge({ origin, factKey }: { origin: string; factKey: string }) {
  if (origin === 'built_in') {
    return (
      <Badge
        variant="secondary"
        data-testid={`fact-origin-${factKey}`}
        title="A property of the product. There is no setting for it, so there is nothing here to switch on or off."
      >
        built into the product
      </Badge>
    );
  }
  if (origin === 'read') {
    return (
      <Badge variant="outline" className="text-muted-foreground" data-testid={`fact-origin-${factKey}`}>
        read
      </Badge>
    );
  }
  // ⚠️ Never «read»: nothing here knows where this value came from, and claiming a query ran is
  // exactly the assertion this page must not make on somebody else's behalf.
  return (
    <Badge variant="outline" className="text-destructive" data-testid={`fact-origin-${factKey}`}>
      origin unclear
    </Badge>
  );
}

/** UTC and explicit about it — a posture read is a timestamped claim, and a local guess would blur it. */
function formatTime(iso: string): string {
  if (!iso) return 'an unstated time — the server sent none';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unstated time — the server sent none';
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}
