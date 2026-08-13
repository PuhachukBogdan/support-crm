'use client';

import { useState } from 'react';
import { AlertTriangle, NotebookPen } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { relativeTime } from '@/features/inbox/wire-labels';
import { usePlayerNotes, type PlayerNoteWire } from './use-player-notes';

/**
 * W35 / feature 040 — **Manager notes** (R35 · U17), on both customer surfaces.
 *
 * ── The name, settled before the component was written ───────────────────────────────────────────
 * Q20 insisted on it: *«на этом проекте уже дважды выходило, что одно слово означало две разные
 * вещи»*. Three things in this product are called notes — the legacy `Player.am_notes` column (never
 * written by anything), a conversation's INTERNAL note (a reply inside a ticket, counted in the detach
 * warning), and these. On screen they are **Manager notes**, and no surface shows two kinds at once.
 *
 * ── What is deliberate about the shape ──────────────────────────────────────────────────────────
 * · **Signed, always.** Author and time on every row (the operator's decision of 2026-08-13): after a
 *   handover the successor is reading somebody else's view, and an unattributed note invites them to
 *   inherit a guess as their own conclusion.
 * · **No edit, no delete controls** — because no such verb exists (Q20: append-only). A correction is a
 *   new note. Rendering a disabled pencil would advertise a capability the product refuses to have.
 * · **Absent, not empty, when the server refuses the read.** An empty list is an ANSWER — *"nobody has
 *   written anything about this customer"* — and giving it to a caller with no clearance would disclose
 *   a fact about a customer. The area therefore disappears entirely on a 403 while still showing a real
 *   error for a real failure: *"you may not see this"* and *"this broke"* must not look the same.
 * · **The warning keeps the text.** When the server recognises contact-shaped text, nothing is stored
 *   and the box still holds what was typed — the one thing that must not be lost at the moment somebody
 *   is being told to reconsider.
 *
 * Every state the production standard asks for is here: loading · empty · error · busy · warned.
 */

/** How the three detector kinds read to a person. A closed set, mirroring the server's vocabulary. */
const KIND_LABEL: Readonly<Record<string, string>> = {
  phone: 'a phone number',
  email: 'an email address',
  handle: 'a messenger handle',
};

const kindsSentence = (kinds: string[]): string => {
  const named = kinds.map((k) => KIND_LABEL[k] ?? k);
  if (named.length <= 1) return named[0] ?? 'contact details';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
};

export function PlayerNotes({
  playerId,
  brandId,
  /** `panel` is the narrow drawer in the ticket window; `page` is the roomier player page. */
  variant = 'panel',
}: {
  playerId: string;
  brandId: string;
  variant?: 'panel' | 'page';
}) {
  const { notes, saving, warning, saveError, add, dismissWarning, reload } = usePlayerNotes(
    playerId,
    brandId,
  );
  const [draft, setDraft] = useState('');

  /**
   * The rows, or `[]` for every non-ready state.
   *
   * ⓘ `AsyncState` carries an `empty` variant this hook never produces (the read answers a list, and an
   * empty list is `ready` with no rows — a real answer about a customer, not an absence of one). Pulling
   * the rows out here keeps that from becoming a fourth branch nobody can reach and the compiler cannot
   * narrow.
   */
  const rows: PlayerNoteWire[] = notes.status === 'ready' ? notes.data : [];

  /**
   * ⚠️ The area is ABSENT for a refusal — see the header.
   *
   * The signal is the sanitized error's CLASS (`refused`), not a status code: the transport maps a 403 to
   * that class and never lets a response body reach the UI (`data/errors.ts`'s own guarantee). And the
   * class is deliberately coarse — it covers a missing permission and a tier refusal alike, because
   * distinguishing them here would re-create the disclosure the server declined to make.
   */
  if (notes.status === 'error' && notes.error.code === 'refused') return null;

  const onAdd = async (acknowledged: boolean) => {
    const body = acknowledged ? (warning?.body ?? draft) : draft;
    const stored = await add(body, { acknowledged });
    // The draft is cleared ONLY on a stored row. A warning or a failure keeps it — losing somebody's
    // sentence at the moment they are asked to reconsider it is the worst possible time to lose it.
    if (stored) setDraft('');
  };

  return (
    <section
      className={variant === 'page' ? 'space-y-3 rounded-md border border-border p-4' : 'space-y-3'}
      data-testid="player-notes"
      aria-label="Manager notes"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className={variant === 'page' ? 'text-sm font-medium' : 'text-xs font-medium text-muted-foreground'}>
          Manager notes
        </h2>
        {notes.status === 'ready' && notes.data.length > 0 && (
          <span className="text-xs text-muted-foreground" data-testid="player-notes-count">
            {notes.data.length}
          </span>
        )}
      </div>

      {/* ── The composer ───────────────────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <Textarea
          data-testid="player-notes-draft"
          aria-label="New note"
          value={draft}
          maxLength={4000}
          rows={variant === 'page' ? 3 : 2}
          placeholder="What should the next person know?"
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter adds — the keyboard floor of the production standard. A bare Enter would
            // make a multi-line note impossible to write, which is what this box is for.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim() && !saving) {
              e.preventDefault();
              void onAdd(false);
            }
          }}
          className="resize-none text-sm"
        />

        {warning && (
          // ⚠️ The registry's `Alert`, not a hand-rolled banner (rule 11). `role="alert"` is what makes
          // this reach a screen reader at the moment it matters.
          <Alert data-testid="player-notes-warning" role="alert">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <AlertTitle>This looks like {kindsSentence(warning.kinds)}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                Contact details are hidden on the card by role. Adding them to a note makes them
                readable by everyone who can see notes, and adding it will be recorded.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="player-notes-acknowledge"
                  disabled={saving}
                  onClick={() => void onAdd(true)}
                >
                  Add anyway
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid="player-notes-edit-instead"
                  onClick={dismissWarning}
                >
                  Let me edit it
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {saveError && !warning && (
          <p className="text-xs text-destructive" data-testid="player-notes-save-error">
            The note was not saved. {saveError.message}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="player-notes-add"
            disabled={saving || draft.trim() === ''}
            onClick={() => void onAdd(false)}
          >
            {/* The busy state says what is happening rather than merely going grey. */}
            {saving && <Spinner className="mr-1 h-3 w-3" aria-hidden />}
            {saving ? 'Adding…' : 'Add note'}
          </Button>
          <span className="text-[11px] text-muted-foreground">Notes cannot be edited or deleted</span>
        </div>
      </div>

      {/* ── The list ───────────────────────────────────────────────────────────────────────────── */}
      {notes.status === 'loading' || notes.status === 'idle' ? (
        <div className="space-y-2" data-testid="player-notes-loading">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : notes.status === 'error' ? (
        <div className="space-y-2" data-testid="player-notes-error">
          {/* Not the empty state: "nothing is written" and "the list could not load" are different
              facts, and a manager acts differently on them (the production floor's own rule). */}
          <p className="text-xs text-destructive">The notes could not load.</p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border-0 py-6" data-testid="player-notes-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NotebookPen aria-hidden />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No notes yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              Anything written here stays with the customer and follows them to the next manager.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2" data-testid="player-notes-list">
          {rows.map((note) => (
            <NoteRow key={note.id} note={note} />
          ))}
        </ItemGroup>
      )}
    </section>
  );
}

/**
 * One note.
 *
 * ⚠️ The byline falls back to the AUTHOR REFERENCE, never to "Unknown" or to a blank. An operator who
 * has left the company resolves to no profile — and that is exactly the case the block exists for (W32
 * hands the portfolio over when somebody leaves), so a placeholder NAME would invent a person while an
 * empty byline would read as an unsigned note.
 */
function NoteRow({ note }: { note: PlayerNoteWire }) {
  const flagged = note.patternKinds.length > 0;
  return (
    <Item
      variant="outline"
      size="sm"
      className="items-start"
      data-testid="player-note"
      data-flagged={flagged ? 'true' : undefined}
    >
      {/*
        ⚠️ `min-w-0` is load-bearing, and only the screenshot showed why: a flex child defaults to its
        content's intrinsic width, so in the 320px drawer the note text ran straight past the panel edge
        and clipped the CONTACT mark off the screen. On the wide page nothing looked wrong at all — which
        is precisely the class of defect a suite cannot see (jsdom has no layout).
      */}
      <ItemContent className="min-w-0">
        {/*
          `whitespace-pre-wrap`: somebody's paragraph breaks are part of what they wrote.
          `break-words`: a long unbroken token (a URL, an id) wraps instead of widening the row.
        */}
        <ItemDescription className="whitespace-pre-wrap break-words text-sm text-foreground line-clamp-none">
          {note.body}
        </ItemDescription>
        <ItemTitle className="mt-1 flex w-full min-w-0 gap-2 text-xs font-normal text-muted-foreground">
          {/*
            ⚠️ The author TRUNCATES and the time does not, and that came from looking at the screenshot:
            when no profile name resolves the byline is a 36-character reference, which wrapped to two
            lines in the 320px drawer and squeezed «just now» into a cramped column beside it. The name
            is the part that can be elided (the full value stays in `title`); the time is four characters
            and is what the reader scans for.
          */}
          <span className="min-w-0 truncate" title={note.authorDisplayName || note.authorRef} data-testid="player-note-author">
            {note.authorDisplayName || note.authorRef}
          </span>
          <span aria-hidden>·</span>
          <time className="shrink-0" dateTime={note.createdAt} title={note.createdAt}>
            {relativeTime(note.createdAt)}
          </time>
          {flagged && (
            // A quiet mark rather than a warning: the author was already told, the fact is recorded,
            // and the reader's interest is only that this note contains contact-shaped text.
            <span
              className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide"
              data-testid="player-note-flag"
              title="Contains contact details — recorded when it was added"
            >
              contact
            </span>
          )}
        </ItemTitle>
      </ItemContent>
    </Item>
  );
}
