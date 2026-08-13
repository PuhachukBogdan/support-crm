import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AsyncState, DataError } from '@/data/types';
import type { ConversationDetail, ThreadMessage } from '@/features/ticket/types';

/**
 * The ticket window's state (W7, roadmap 9.3) — ONE open conversation: its detail, its thread, and
 * the composer's in-flight send. A second window replaces the first (`open` resets everything);
 * holding several belongs to W10's open-tickets list, not here.
 *
 * ── The thread is a drained ARRAY, not a paged result ────────────────────────────────────────────
 * The server pages oldest-first with a keyset cursor and no tail read, so the window drains pages
 * until exhausted (bounded — see the saga) and renders the whole thread. `truncated` states when
 * the bound was hit rather than silently showing a partial thread as a whole one.
 */
export interface TicketState {
  /** Which conversation the window holds; actions carry ids so a stale response cannot land. */
  id: string | null;
  detail: AsyncState<ConversationDetail>;
  thread: AsyncState<ThreadMessage[]>;
  threadTruncated: boolean;
  send: { status: 'idle' | 'sending' } | { status: 'error'; error: DataError };
}

const initialState: TicketState = {
  id: null,
  detail: { status: 'idle' },
  thread: { status: 'idle' },
  threadTruncated: false,
  send: { status: 'idle' },
};

/** Ignore a response that belongs to a conversation the window no longer shows. */
const stale = (state: TicketState, id: string) => state.id !== id;

export const ticketSlice = createSlice({
  name: 'ticket',
  initialState,
  reducers: {
    /** Opening (or switching to) a ticket: everything of the previous one is discarded. */
    open: (_state, action: PayloadAction<{ id: string }>): TicketState => ({
      ...initialState,
      id: action.payload.id,
      detail: { status: 'loading' },
      thread: { status: 'loading' },
    }),
    /**
     * A LIVE re-read (socket event, reconnect, after a write). Keeps what is on screen — the same
     * no-flash rule the Inbox's `load` learned the hard way; only the answer replaces it.
     */
    refresh: (state, action: PayloadAction<{ id: string }>): TicketState =>
      stale(state, action.payload.id) ? state : state,
    detailLoaded: (state, action: PayloadAction<{ id: string; detail: ConversationDetail }>) => {
      if (stale(state, action.payload.id)) return;
      state.detail = { status: 'ready', data: action.payload.detail };
    },
    detailFailed: (state, action: PayloadAction<{ id: string; error: DataError }>) => {
      if (stale(state, action.payload.id)) return;
      state.detail = { status: 'error', error: action.payload.error };
    },
    threadLoaded: (
      state,
      action: PayloadAction<{ id: string; messages: ThreadMessage[]; truncated: boolean }>,
    ) => {
      if (stale(state, action.payload.id)) return;
      // An empty thread is a real, renderable answer (a ticket can hold zero visible messages);
      // 'empty' keeps the shared state vocabulary rather than a zero-length 'ready'.
      state.thread =
        action.payload.messages.length === 0
          ? { status: 'empty' }
          : { status: 'ready', data: action.payload.messages };
      state.threadTruncated = action.payload.truncated;
    },
    threadFailed: (state, action: PayloadAction<{ id: string; error: DataError }>) => {
      if (stale(state, action.payload.id)) return;
      state.thread = { status: 'error', error: action.payload.error };
    },
    /**
     * The composer's send — a reply or a private note, optionally with a status to submit as
     * (`Submit as <status>`: message first, then the status change, one gesture).
     * ⚠️ `kind` is passed VERBATIM to the server, which refuses an unknown one with a 400 — the
     * client never coerces, for the same reason the gateway refuses: an intended internal note
     * published to a customer is the worst defect this screen can produce (SEC-13).
     */
    send: {
      reducer: (state): void => {
        state.send = { status: 'sending' };
      },
      prepare: (payload: {
        id: string;
        kind: 'reply' | 'note';
        body: string;
        uploadIds?: string[];
        statusTo?: string;
      }) => ({ payload }),
    },
    sendSucceeded: (state, action: PayloadAction<{ id: string }>) => {
      if (stale(state, action.payload.id)) return;
      state.send = { status: 'idle' };
    },
    sendFailed: (state, action: PayloadAction<{ id: string; error: DataError }>) => {
      if (stale(state, action.payload.id)) return;
      state.send = { status: 'error', error: action.payload.error };
    },
    /** Leaving the window. Explicit, so a stray late response has nothing to land in. */
    close: (): TicketState => initialState,
  },
});

export const ticketActions = ticketSlice.actions;
export const ticketReducer = ticketSlice.reducer;
