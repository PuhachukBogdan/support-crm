import { all, fork } from 'redux-saga/effects';
import { sampleSaga } from './sample.saga';

export function* rootSaga() {
  yield all([fork(sampleSaga)]);
}
