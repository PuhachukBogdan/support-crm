import { all, call, fork, put, takeLatest, takeLeading } from 'redux-saga/effects';
import { getDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { PaginatedResult } from '@/data/types';
import type { ConversationDetail, ThreadMessage } from '@/features/ticket/types';
import { ticketActions } from './ticket.slice';

/**
 * The ticket window's sagas (W7, roadmap 9.3).
 *
 * `open` and `refresh` run the same two reads; `takeLatest` on both means switching tickets
 * cancels the previous window's in-flight reads, so a slow thread cannot land in the wrong ticket
 * (the slice also drops stale ids — belt and brace, same as the Inbox's dedup).
 */

/**
 * ⚠️ The thread endpoint pages OLDEST-FIRST and has no tail read, so the window drains it.
 * Bounded: 6 pages × 100 = 600 messages, far beyond a working support thread. When the bound is
 * hit the thread renders TRUNCATED AND SAYS SO — a partial thread shown as a whole one is the
 * confidently-wrong-answer shape. ⇒ If real history ever hits this, the fix is a server-side tail
 * cursor (recorded in the W7 notes), not a bigger number here.
 */
const THREAD_PAGE_SIZE = 100;
const MAX_THREAD_PAGES = 6;

function* loadDetail(id: string) {
  try {
    const da = getDataAccess();
    const detail: ConversationDetail = yield call([da, da.get], 'conversations', id);
    yield put(ticketActions.detailLoaded({ id, detail }));
  } catch (e) {
    yield put(ticketActions.detailFailed({ id, error: toDataError(e) }));
  }
}

function* loadThread(id: string) {
  try {
    const da = getDataAccess();
    const messages: ThreadMessage[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_THREAD_PAGES) {
        truncated = true;
        break;
      }
      const res: PaginatedResult<ThreadMessage> = yield call([da, da.list], 'conversation-thread', {
        limit: THREAD_PAGE_SIZE,
        cursor,
        within: id,
      });
      messages.push(...res.items);
      if (!res.hasMore || res.nextCursor === null) break;
      cursor = res.nextCursor;
    }
    yield put(ticketActions.threadLoaded({ id, messages, truncated }));
  } catch (e) {
    yield put(ticketActions.threadFailed({ id, error: toDataError(e) }));
  }
}

function* loadBoth(action: { type: string; payload: { id: string } }) {
  yield all([call(loadDetail, action.payload.id), call(loadThread, action.payload.id)]);
}

/**
 * One send = the message, then (when asked) the status — strictly in that order: «Submit as
 * Solved» with a failed message must not solve the ticket with the answer unsent. A failed status
 * change after a sent message surfaces as the send error, and the thread re-read still shows the
 * message — the truth, stated.
 *
 * `takeLeading`: a second click while one send is in flight is dropped, not queued — the
 * double-send defect is a duplicate customer-visible message, which no de-dup can retract.
 */
function* sendMessage(action: ReturnType<typeof ticketActions.send>) {
  const { id, kind, body, uploadIds, statusTo } = action.payload;
  try {
    const da = getDataAccess();
    yield call([da, da.create], 'conversation-messages', {
      kind,
      body,
      ...(uploadIds && uploadIds.length > 0 ? { uploadIds } : {}),
    }, id);
    if (statusTo) {
      yield call([da, da.update], 'conversation-status', '', { status: statusTo }, id);
    }
    yield put(ticketActions.sendSucceeded({ id }));
    // Re-read rather than merge: the server's thread is the record (ids, timestamps, attachment
    // metadata all minted there), and the read path is where every visibility rule lives.
    yield all([call(loadThread, id), ...(statusTo ? [call(loadDetail, id)] : [])]);
  } catch (e) {
    yield put(ticketActions.sendFailed({ id, error: toDataError(e) }));
  }
}

export function* ticketSaga() {
  yield fork(function* () {
    yield takeLatest(ticketActions.open.type, loadBoth);
  });
  yield fork(function* () {
    yield takeLatest(ticketActions.refresh.type, loadBoth);
  });
  yield fork(function* () {
    yield takeLeading(ticketActions.send.type, sendMessage);
  });
}
