'use client';

import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/composites/states';
import { relativeTime } from '@/features/inbox/wire-labels';
import { API_PREFIX } from '@/data/gateway/http-port';
import type { AsyncState } from '@/data/types';
import type { MessageAttachment, ThreadMessage } from './types';

/**
 * The conversation thread (W7, roadmap 9.3) — oldest first, latest at the bottom, scrolled there on
 * arrival, exactly as the operator reads a chat.
 *
 * Four kinds, four treatments (frame `031-ticket-window-full`):
 *  · incoming customer — plain block on the muted surface;
 *  · public reply — bordered block on the card surface;
 *  · ⭐ private note — the visually LOUD one: distinct edge + tinted surface + an explicit chip.
 *    A note mistaken for a reply is how internal text reaches a customer's screen-share; the
 *    treatment errs on the side of unmistakable (SEC-13's UI half);
 *  · system — a centered whisper, not a bubble (nothing wrote these yet server-side; the shape is
 *    here so the first one renders as an event, not as somebody's words).
 *
 * ⚠️ One tree for all four states — the scroll container never unmounts (DataTable's rule, applied
 * from birth here rather than retrofitted after a freeze).
 */
export function Thread({
  state,
  truncated,
  onRetry,
}: {
  state: AsyncState<ThreadMessage[]>;
  truncated: boolean;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = state.status === 'ready' ? state.data : [];

  // Pin to the latest message when the thread (re)arrives. `scrollTop = scrollHeight` is enough —
  // smooth scrolling on every live refresh would yank the reader who scrolled up on purpose, so it
  // fires only when the LAST message id changes, not on every re-render.
  const lastId = messages.length > 0 ? messages[messages.length - 1]!.id : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el && lastId) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  return (
    <div
      ref={scrollRef}
      data-testid="ticket-thread"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-4 py-3"
    >
      {state.status === 'loading' || state.status === 'idle' ? (
        <div className="space-y-3" data-testid="thread-loading">
          <Skeleton className="h-16 w-3/4" />
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="h-16 w-3/4" />
        </div>
      ) : null}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={onRetry} />}
      {state.status === 'empty' && (
        <p className="py-8 text-center text-sm text-muted-foreground">No messages in this ticket yet.</p>
      )}
      {truncated && (
        // Stated, never silent: a partial thread rendered as a whole one is a wrong answer.
        <p className="pb-3 text-center text-xs text-muted-foreground" data-testid="thread-truncated">
          This thread is longer than the window loads — showing the first 600 messages.
        </p>
      )}
      <ol className="space-y-3">
        {messages.map((m) => (
          <li key={m.id}>
            <MessageBlock message={m} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function MessageBlock({ message }: { message: ThreadMessage }) {
  if (message.kind === 'MESSAGE_KIND_SYSTEM') {
    return (
      <p className="py-1 text-center text-xs italic text-muted-foreground" data-kind="system">
        {message.body}
      </p>
    );
  }

  const isNote = message.kind === 'MESSAGE_KIND_PRIVATE_NOTE';
  const isCustomer = message.kind === 'MESSAGE_KIND_INCOMING_CUSTOMER';
  // ⓘ No operator directory is exposed yet, so a staff author renders as a role word; the id rides
  // the title attribute for a supervisor who needs to know exactly who. Names are a later, separate
  // read — inventing them here from ids would be a guess wearing a name's clothes.
  const author = isCustomer ? 'Customer' : 'Agent';

  return (
    <div
      data-kind={isNote ? 'note' : isCustomer ? 'customer' : 'reply'}
      className={
        isNote
          ? 'rounded-md border-l-4 border-primary/60 bg-accent p-3'
          : isCustomer
            ? 'rounded-md bg-muted p-3'
            : 'rounded-md border border-border bg-card p-3'
      }
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground" title={message.authorId || undefined}>
          {author}
        </span>
        {isNote && (
          <Badge variant="outline" className="border-primary/60 text-primary" data-testid="note-chip">
            Internal
          </Badge>
        )}
        <span>{relativeTime(message.createdAt)}</span>
      </div>
      {/* The body is text, rendered as text — whatever a customer typed stays inert (SEC-26). */}
      <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
      {message.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {message.attachments.map((a) => (
            <li key={a.uploadId}>
              <AttachmentChip attachment={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * An attachment: images show their server-made 256px derivative, everything else a named link.
 * Both URLs are same-origin gateway routes — the browser carries the session cookie itself, and the
 * server decides visibility on every fetch (nothing here proves anything about access).
 */
function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const href = `${API_PREFIX}/uploads/${encodeURIComponent(attachment.uploadId)}`;
  const name = attachment.displayName || 'attachment';
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
    >
      {attachment.hasDerivative ? (
        // A plain <img>, deliberately: next/image would route the bytes through the optimizer,
        // which fetches server-side WITHOUT the session cookie — the thumb would 401 in production
        // and only there. Same-origin + the browser's own cookie is the whole auth story here.
        <img src={`${href}/thumb`} alt={name} className="max-h-16 rounded" />
      ) : null}
      <span className="max-w-48 truncate">{name}</span>
    </a>
  );
}
