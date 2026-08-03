import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AsyncState, DataError, PaginatedResult, Query } from '@/data/types';
import type { ConversationRow } from '@/features/inbox/types';

type State = AsyncState<PaginatedResult<ConversationRow>>;

/**
 * The Inbox's list state (feature 029, roadmap 9.2).
 *
 * ── Why this is not `createAsyncListSlice` ───────────────────────────────────────────────────────
 * That factory REPLACES the page on every success, which is right for a screen that shows one page.
 * This queue holds 3.6K–4.5K rows and pages through them with a keyset cursor, so a second page must
 * be APPENDED — replacing it would make "load more" jump to page two and lose page one, and the
 * virtualizer would scroll back to the top under the person's hands.
 *
 * Everything else is deliberately identical: the same `AsyncState`, so the screen renders from the
 * one shared state shape and the loading/empty/error convention is not re-invented here.
 */
const initialState = { status: 'idle' } as State;

export const conversationsSlice = createSlice({
  name: 'conversations',
  initialState,
  reducers: {
    /**
     * A FRESH read: first mount, or any change of filter or order.
     *
     * ⚠️ Goes to `loading`, discarding what is on screen. That is correct for a changed narrowing —
     * the rows shown belong to the previous question, and keeping them visible under a new filter
     * would show the person an answer to something they did not ask.
     */
    load: {
      /**
       * ⭐⭐ **Keeps the rows on screen while the next answer is fetched — and that is a BUG FIX, not
       * a refinement.**
       *
       * This used to return `{status:'loading'}` unconditionally, which made `DataTable` take its
       * early-return branch and **unmount the whole table**: a few hundred DOM nodes removed
       * synchronously, in the same commit as the `<select>`'s value update.
       *
       * ⚠️ When that commit happens while Chromium's **native dropdown popup is closing**, the
       * renderer spins at 100% CPU and never recovers — the tab stops answering clicks, scrolling and
       * even DevTools, and the operator sees an empty `<body>`. Reproduced live: changing the sort
       * PROGRAMMATICALLY never froze; the identical change made through the real popup froze every
       * time. That is why three rounds of headless testing found nothing.
       *
       * Keeping `ready` removes the teardown entirely. It is also the better behaviour: the list no
       * longer blinks to a skeleton and back on every filter change, and the scroll position holds.
       *
       * ⚠️ The trade-off, stated: for the moments a request is in flight the rows on screen answer
       * the PREVIOUS question. `takeLatest` guarantees only the newest response is applied, and the
       * round-trip is tens of milliseconds — but if this ever gets slow, a dimmed "updating" state is
       * the fix, not a return to unmounting.
       */
      reducer: (state): State => (state.status === 'ready' ? state : { status: 'loading' }),
      prepare: (query: Query) => ({ payload: query }),
    },
    /**
     * A CONTINUATION: same narrowing, next page.
     *
     * Keeps the current rows on screen — no spinner, no scroll jump. If nothing is loaded yet this is
     * indistinguishable from a fresh load, so it falls back to one.
     */
    loadMore: {
      reducer: (state): State => state,
      prepare: (query: Query) => ({ payload: query }),
    },
    succeeded: (_state, action: PayloadAction<PaginatedResult<ConversationRow>>): State =>
      action.payload.items.length === 0
        ? { status: 'empty' }
        : { status: 'ready', data: action.payload },
    /**
     * The next page's rows, appended.
     *
     * ⚠️ De-duplicated by id. A keyset page should never overlap the previous one, but if the order
     * and the cursor ever disagreed it would — and React would throw on duplicate keys, or worse,
     * silently render the same conversation twice. The server refuses a cross-order token (R8); this
     * is the belt to that brace, and it is cheap.
     */
    appended: (state, action: PayloadAction<PaginatedResult<ConversationRow>>): State => {
      if (state.status !== 'ready') {
        return action.payload.items.length === 0
          ? { status: 'empty' }
          : { status: 'ready', data: action.payload };
      }
      const seen = new Set(state.data.items.map((r) => r.id));
      const fresh = action.payload.items.filter((r) => !seen.has(r.id));
      return {
        status: 'ready',
        data: {
          items: [...state.data.items, ...fresh],
          nextCursor: action.payload.nextCursor,
          hasMore: action.payload.hasMore,
        },
      };
    },
    failed: (_state, action: PayloadAction<DataError>): State => ({
      status: 'error',
      error: action.payload,
    }),
    reset: (): State => ({ status: 'idle' }),
  },
});

export const conversationsActions = conversationsSlice.actions;
export const conversationsReducer = conversationsSlice.reducer;
