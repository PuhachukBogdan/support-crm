'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { TicketState } from '@/store/ticket/ticket.slice';

/**
 * The composer (W7, roadmap 9.3) — frame `031`: a type switch (public reply / internal note), the
 * text area, send. The note mode is IMPOSSIBLE to mistake for the reply mode: the whole surface
 * tints, the same treatment the note carries in the thread — because the one unforgivable defect
 * here is internal text leaving the building (SEC-13).
 *
 * ⚠️ `kind` goes to the server verbatim ('reply' | 'note'); the server refuses anything else with a
 * 400 rather than defaulting — this control is the only place the choice is made.
 *
 * ⓘ «Apply macro» (W8) and «Submit as <status>» (W7-6) dock onto this bar later; attachments too.
 * The draft is local state on purpose: it belongs to the unsent message, not to the record.
 */
export function Composer({
  send,
  sendState,
}: {
  send: (input: { kind: 'reply' | 'note'; body: string }) => void;
  sendState: TicketState['send'];
}) {
  const [kind, setKind] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const sending = sendState.status === 'sending';
  const isNote = kind === 'note';

  const submit = () => {
    const text = body.trim();
    if (!text || sending) return;
    send({ kind, body: text });
    // Optimistic ONLY about the draft box: the message itself appears when the re-read returns it.
    // A failed send keeps nothing to retype because the error keeps the state and the text is short-
    // lived; if this ever bites, the fix is restoring the draft on `sendFailed`, recorded here.
    setBody('');
  };

  return (
    <div
      data-testid="composer"
      className={cn('shrink-0 border-t border-border p-3', isNote && 'bg-accent')}
    >
      <div className="mb-2 flex items-center gap-1" role="tablist" aria-label="Message type">
        <ModeButton active={!isNote} onClick={() => setKind('reply')} testId="composer-mode-reply">
          Public reply
        </ModeButton>
        <ModeButton active={isNote} onClick={() => setKind('note')} testId="composer-mode-note">
          Internal note
        </ModeButton>
      </div>

      <Textarea
        data-testid="composer-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends only with a modifier — a support answer is multi-line prose, and an
          // accidental half-sent reply to a customer is not undoable.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        placeholder={isNote ? 'Write an internal note — the customer never sees it' : 'Write a reply to the customer'}
        rows={3}
        className="resize-none bg-background"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        {sendState.status === 'error' ? (
          <p className="text-xs text-destructive" data-testid="composer-error">
            {sendState.error.message}
          </p>
        ) : (
          <span />
        )}
        <Button
          data-testid="composer-send"
          onClick={submit}
          disabled={sending || body.trim() === ''}
          variant={isNote ? 'secondary' : 'default'}
        >
          {sending ? 'Sending…' : isNote ? 'Add note' : 'Send reply'}
        </Button>
      </div>
    </div>
  );
}

/** A mode tab. Plain buttons — the two-state switch needs no library state machine behind it. */
function ModeButton({
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
      className={cn(
        'rounded-md px-3 py-1 text-sm',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}
