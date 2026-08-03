import { all, fork } from 'redux-saga/effects';
import { sampleSaga } from './sample.saga';
import { recordsSaga } from './records/records.sagas';
import { conversationsSaga } from './conversations/conversations.sagas';

export function* rootSaga() {
  yield all([fork(sampleSaga), fork(recordsSaga), fork(conversationsSaga)]);
}
