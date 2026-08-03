import { call, put, takeLatest } from 'redux-saga/effects';
import { getDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { PaginatedResult, Query } from '@/data/types';
import type { ConversationRow } from '@/features/inbox/types';
import { conversationsActions } from './conversations.slice';

/**
 * The Inbox's list saga (feature 029).
 *
 * Two triggers, one request shape: `load` replaces, `loadMore` appends. Both go through the same
 * `DataAccess.list`, resolved at call time so the current binding is always used.
 *
 * ⚠️ `takeLatest` on BOTH, and they share nothing else: a superseded request's handler is cancelled,
 * so a slow first page cannot land after a filter change and overwrite the newer answer. That matters
 * more here than on a one-shot screen — an agent changing filters quickly would otherwise watch rows
 * from an abandoned query arrive.
 */
function* handle(
  action: { type: string; payload: Query },
  done: typeof conversationsActions.succeeded | typeof conversationsActions.appended,
) {
  try {
    const da = getDataAccess();
    const res: PaginatedResult<ConversationRow> = yield call(
      [da, da.list],
      'conversations',
      action.payload,
    );
    yield put(done(res));
  } catch (e) {
    yield put(conversationsActions.failed(toDataError(e)));
  }
}

export function* conversationsSaga() {
  yield takeLatest(conversationsActions.load.type, function* (a: { type: string; payload: Query }) {
    yield* handle(a, conversationsActions.succeeded);
  });
  yield takeLatest(
    conversationsActions.loadMore.type,
    function* (a: { type: string; payload: Query }) {
      yield* handle(a, conversationsActions.appended);
    },
  );
}
