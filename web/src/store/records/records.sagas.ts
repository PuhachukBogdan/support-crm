import { makeListSaga } from '../async/run-resource.saga';
import { recordsActions } from './records.slice';
import type { DemoRecord } from '@/data/mock/demo-data';

export const recordsSaga = makeListSaga<DemoRecord>('records', recordsActions);
