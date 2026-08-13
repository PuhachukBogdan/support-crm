import { all, call, fork, put, takeLatest, takeLeading } from 'redux-saga/effects';
import { getDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { PaginatedResult } from '@/data/types';
import type { ConversationDetail, LabelWire, ThreadMessage } from '@/features/ticket/types';
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

/**
 * W7-7 — both label lists in one read: the conversation's own set and the account registry the
 * «add tag» control offers. A failure here downgrades the tags block, never the window.
 */
function* loadLabels(id: string) {
  try {
    const da = getDataAccess();
    const [mine, account]: [PaginatedResult<LabelWire>, PaginatedResult<LabelWire>] = yield all([
      call([da, da.list], 'conversation-labels', { limit: 100, within: id }),
      call([da, da.list], 'labels', { limit: 100 }),
    ]);
    yield put(ticketActions.labelsLoaded({ id, labels: mine.items, accountLabels: account.items }));
  } catch (e) {
    yield put(ticketActions.labelsFailed({ id, error: toDataError(e) }));
  }
}

function* loadBoth(action: { type: string; payload: { id: string } }) {
  yield all([
    call(loadDetail, action.payload.id),
    call(loadThread, action.payload.id),
    call(loadLabels, action.payload.id),
  ]);
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

/**
 * W7-7 — the left column's writes: place, then re-read what the write touched. `takeLeading` for
 * the same reason as `send` — a second click mid-flight is dropped, not queued. The label pair is
 * IDEMPOTENT server-side (PUT attach / DELETE detach), so a retry after an error is always safe.
 */
function* takeIt(action: ReturnType<typeof ticketActions.takeIt>) {
  const { id, operatorId } = action.payload;
  try {
    const da = getDataAccess();
    yield call([da, da.update], 'conversation-assignee', '', { operatorId }, id);
    yield put(ticketActions.mutationSucceeded({ id }));
    yield call(loadDetail, id);
  } catch (e) {
    yield put(ticketActions.mutationFailed({ id, error: toDataError(e) }));
  }
}

function* attachLabel(action: ReturnType<typeof ticketActions.attachLabel>) {
  const { id, labelId } = action.payload;
  try {
    const da = getDataAccess();
    yield call([da, da.update], 'conversation-labels', labelId, undefined, id);
    yield put(ticketActions.mutationSucceeded({ id }));
    yield call(loadLabels, id);
  } catch (e) {
    yield put(ticketActions.mutationFailed({ id, error: toDataError(e) }));
  }
}

function* detachLabel(action: ReturnType<typeof ticketActions.detachLabel>) {
  const { id, labelId } = action.payload;
  try {
    const da = getDataAccess();
    yield call([da, da.remove], 'conversation-labels', labelId, id);
    yield put(ticketActions.mutationSucceeded({ id }));
    yield call(loadLabels, id);
  } catch (e) {
    yield put(ticketActions.mutationFailed({ id, error: toDataError(e) }));
  }
}

/**
 * W8 — apply a macro: POST to the macro's path under the conversation, then re-read what a macro
 * can touch (status/priority/assignee → detail; add_label → labels). The thread is untouched by
 * every action type in the catalogue, so it is deliberately not re-read.
 */
function* applyMacro(action: ReturnType<typeof ticketActions.applyMacro>) {
  const { id, macroId } = action.payload;
  try {
    const da = getDataAccess();
    yield call([da, da.update], 'conversation-macros', macroId, undefined, id);
    yield put(ticketActions.mutationSucceeded({ id }));
    yield all([call(loadDetail, id), call(loadLabels, id)]);
  } catch (e) {
    yield put(ticketActions.mutationFailed({ id, error: toDataError(e) }));
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
  yield fork(function* () {
    yield takeLeading(ticketActions.takeIt.type, takeIt);
  });
  yield fork(function* () {
    yield takeLeading(ticketActions.attachLabel.type, attachLabel);
  });
  yield fork(function* () {
    yield takeLeading(ticketActions.detachLabel.type, detachLabel);
  });
  yield fork(function* () {
    yield takeLeading(ticketActions.applyMacro.type, applyMacro);
  });
}
