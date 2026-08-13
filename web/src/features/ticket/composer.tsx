'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useAttachmentUpload } from './use-attachment-upload';
import type { CannedResponseWire, MacroWire } from './types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { TicketState } from '@/store/ticket/ticket.slice';

/** A status the composer may submit as — the ACTIVE slice of the account's own catalogue. */
export interface SubmitStatusOption {
  key: string;
  agentName: string;
}

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
  statusOptions = [],
  macros = [],
  canned = [],
  onApplyMacro,
}: {
  send: (input: { kind: 'reply' | 'note'; body: string; statusTo?: string }) => void;
  sendState: TicketState['send'];
  /**
   * «Submit as <status>» (frame 031's split button): message first, then the status, one gesture.
   * Options are the account's ACTIVE statuses by agent name — a retired status is unofferable, the
   * same rule the Inbox funnel learned. Empty ⇒ the split half simply does not render.
   */
  statusOptions?: readonly SubmitStatusOption[];
  /**
   * W8 — the two pickers (frame 031's «Apply macro» bar). A macro APPLIES to the conversation
   * (server-side bundle, all-or-nothing); a canned response INSERTS its text into the draft. Empty
   * list ⇒ the picker does not render — an absent button reads as "not set up", which is the truth.
   */
  macros?: readonly MacroWire[];
  canned?: readonly CannedResponseWire[];
  onApplyMacro?: (macroId: string) => void;
}) {
  const [kind, setKind] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const files = useAttachmentUpload();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sending = sendState.status === 'sending';
  const isNote = kind === 'note';

  const submit = (statusTo?: string) => {
    const text = body.trim();
    if (!text || sending || files.uploading) return;
    send({
      kind,
      body: text,
      ...(files.attachments.length > 0 ? { uploadIds: files.attachments.map((a) => a.uploadId) } : {}),
      ...(statusTo ? { statusTo } : {}),
    });
    // Optimistic ONLY about the draft box: the message itself appears when the re-read returns it.
    // A failed send keeps nothing to retype because the error keeps the state and the text is short-
    // lived; if this ever bites, the fix is restoring the draft on `sendFailed`, recorded here.
    setBody('');
    files.clear();
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
        aria-label={isNote ? 'Internal note' : 'Public reply'}
        placeholder={isNote ? 'Write an internal note — the customer never sees it' : 'Write a reply to the customer'}
        rows={3}
        className="resize-none bg-background"
      />

      {(files.attachments.length > 0 || files.error) && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="composer-attachments">
          {files.attachments.map((a) => (
            <Badge key={a.uploadId} variant="outline" className="gap-1 pr-1">
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove attachment ${a.name}`}
                onClick={() => files.remove(a.uploadId)}
                className="rounded px-1 hover:bg-muted"
              >
                ×
              </button>
            </Badge>
          ))}
          {files.error && (
            <p className="text-xs text-destructive" data-testid="attachment-error">
              {files.error}
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* The input is the real control; the button is its face. Value reset on every pick so
              choosing the same file twice (after a removal) still fires `change`. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            data-testid="composer-file-input"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void files.add(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="composer-attach"
            disabled={sending || files.uploading}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
          >
            {files.uploading ? 'Uploading…' : '📎 Attach'}
          </Button>
          {macros.length > 0 && onApplyMacro && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" data-testid="composer-macro" disabled={sending}>
                  ⚡ Apply macro
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {macros.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => onApplyMacro(m.id)}>
                    {m.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canned.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" data-testid="composer-canned" disabled={sending}>
                  📋 Template
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {canned.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    // INSERTS into the draft — the person still reads and sends it themselves. A
                    // template that sent itself would be a macro with none of a macro's checks.
                    onSelect={() => setBody((prev) => (prev.trim() === '' ? c.body : `${prev}\n${c.body}`))}
                  >
                    {c.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {sendState.status === 'error' && (
            <p className="text-xs text-destructive" data-testid="composer-error">
              {sendState.error.message}
            </p>
          )}
        </div>
        <div className="flex items-center gap-px">
          <Button
            data-testid="composer-send"
            onClick={() => submit()}
            disabled={sending || body.trim() === ''}
            variant={isNote ? 'secondary' : 'default'}
            className={statusOptions.length > 0 ? 'rounded-r-none' : undefined}
          >
            {sending ? 'Sending…' : isNote ? 'Add note' : 'Send reply'}
          </Button>
          {statusOptions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  data-testid="composer-submit-as"
                  disabled={sending || body.trim() === ''}
                  variant={isNote ? 'secondary' : 'default'}
                  className="rounded-l-none px-2"
                  aria-label="Submit as a status"
                >
                  ▾
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {statusOptions.map((s) => (
                  <DropdownMenuItem key={s.key} onSelect={() => submit(s.key)}>
                    Submit as {s.agentName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
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
