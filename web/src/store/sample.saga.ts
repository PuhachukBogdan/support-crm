import { put, takeLatest } from 'redux-saga/effects';
import { ping, setMessage } from './sample.slice';

// Sample saga — proves Redux-Saga middleware is wired (R7). Reacts to `ping` by
// dispatching a follow-up action. No product side effects yet.
function* onPing() {
  yield put(setMessage('pong (from saga)'));
}

export function* sampleSaga() {
  yield takeLatest(ping.type, onPing);
}
