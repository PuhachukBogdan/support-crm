import { configureStore } from '@reduxjs/toolkit';
import createSagaMiddleware from 'redux-saga';
import { sampleReducer } from './sample.slice';
import { rootSaga } from './root-saga';

// R7: create a FRESH store per call (no module-level singleton). Under App Router SSR a
// shared store would leak state between requests/users — the per-request factory is the
// known-safe pattern. Mounted via a "use client" <Providers> boundary in the root layout.
export function makeStore() {
  const sagaMiddleware = createSagaMiddleware();
  const store = configureStore({
    reducer: { sample: sampleReducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(sagaMiddleware),
  });
  sagaMiddleware.run(rootSaga);
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
