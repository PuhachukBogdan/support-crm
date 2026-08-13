import { all, fork } from 'redux-saga/effects';
import { sampleSaga } from './sample.saga';
import { recordsSaga } from './records/records.sagas';
import { conversationsSaga } from './conversations/conversations.sagas';
import { ticketSaga } from './ticket/ticket.sagas';

export function* rootSaga() {
  yield all([fork(sampleSaga), fork(recordsSaga), fork(conversationsSaga), fork(ticketSaga)]);
}
