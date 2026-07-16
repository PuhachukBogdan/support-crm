import { createAsyncListSlice } from '../async/create-async-slice';
import type { DemoRecord } from '@/data/mock/demo-data';

// Example domain slice (US2). Real domains (tickets, contacts, …) follow the same factory.
export const recordsSlice = createAsyncListSlice<DemoRecord>('records');
export const recordsActions = recordsSlice.actions;
export const recordsReducer = recordsSlice.reducer;
