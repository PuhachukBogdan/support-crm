import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AsyncState, DataError } from '@/data/types';
import type { ConversationDetail, LabelWire, ThreadMessage } from '@/features/ticket/types';

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
  /**
   * W7-7 — tags. `labels` is THIS conversation's set; `accountLabels` is the account's whole
   * registry (what «add tag» may offer — attach-only in the MVP: the registry screen is W16's).
   * Failures render as an inline note, not a dead window: tags are an annotation, never the record.
   */
  labels: AsyncState<LabelWire[]>;
  accountLabels: AsyncState<LabelWire[]>;
  /** One field-mutation (take it / tag attach / detach) in flight at a time — same as `send`. */
  mutation: { status: 'idle' | 'busy' } | { status: 'error'; error: DataError };
}

const initialState: TicketState = {
  id: null,
  detail: { status: 'idle' },
  thread: { status: 'idle' },
  threadTruncated: false,
  send: { status: 'idle' },
  labels: { status: 'idle' },
  accountLabels: { status: 'idle' },
  mutation: { status: 'idle' },
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
    /** W7-7 — tags arrive (both lists ride one action: they load and reload together). */
    labelsLoaded: (
      state,
      action: PayloadAction<{ id: string; labels: LabelWire[]; accountLabels: LabelWire[] }>,
    ) => {
      if (stale(state, action.payload.id)) return;
      state.labels = { status: 'ready', data: action.payload.labels };
      state.accountLabels = { status: 'ready', data: action.payload.accountLabels };
    },
    labelsFailed: (state, action: PayloadAction<{ id: string; error: DataError }>) => {
      if (stale(state, action.payload.id)) return;
      state.labels = { status: 'error', error: action.payload.error };
    },
    /**
     * W7-7 — the left column's writes. Each is fire-once (`takeLeading`), then the saga re-reads
     * what the write touched; nothing is merged locally. «take it» carries the caller's OWN
     * operator id from `/me/operator` — there is no field to name anyone else, mirroring 5.11.
     */
    takeIt: {
      reducer: (state): void => {
        state.mutation = { status: 'busy' };
      },
      prepare: (payload: { id: string; operatorId: string }) => ({ payload }),
    },
    attachLabel: {
      reducer: (state): void => {
        state.mutation = { status: 'busy' };
      },
      prepare: (payload: { id: string; labelId: string }) => ({ payload }),
    },
    detachLabel: {
      reducer: (state): void => {
        state.mutation = { status: 'busy' };
      },
      prepare: (payload: { id: string; labelId: string }) => ({ payload }),
    },
    /**
     * W8 — apply a macro. All-or-nothing SERVER-side (FR-008): a refused bundle leaves zero
     * changes, so the re-read after either outcome shows the truth. The service re-checks the
     * permission of every action inside, so this can never widen what the caller may do.
     */
    applyMacro: {
      reducer: (state): void => {
        state.mutation = { status: 'busy' };
      },
      prepare: (payload: { id: string; macroId: string }) => ({ payload }),
    },
    mutationSucceeded: (state, action: PayloadAction<{ id: string }>) => {
      if (stale(state, action.payload.id)) return;
      state.mutation = { status: 'idle' };
    },
    mutationFailed: (state, action: PayloadAction<{ id: string; error: DataError }>) => {
      if (stale(state, action.payload.id)) return;
      state.mutation = { status: 'error', error: action.payload.error };
    },
    /** Leaving the window. Explicit, so a stray late response has nothing to land in. */
    close: (): TicketState => initialState,
  },
});

export const ticketActions = ticketSlice.actions;
export const ticketReducer = ticketSlice.reducer;
