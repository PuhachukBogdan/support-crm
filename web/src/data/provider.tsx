'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { DataAccess } from './data-access';
import { MockDataAccess } from './mock/mock-data-access';

// Module-level binding so sagas (outside the React tree) resolve the same implementation.
let current: DataAccess = new MockDataAccess();

/** Saga/non-React accessor for the active implementation. */
export function getDataAccess(): DataAccess {
  return current;
}
/** Swap the active implementation (mock ↔ real). Single swap point. */
export function setDataAccess(impl: DataAccess): void {
  current = impl;
}

const DataAccessContext = createContext<DataAccess | null>(null);

/**
 * Binds the active DataAccess for the subtree. Pass `impl` to override (mock/stub/real);
 * screens read it via useDataAccess() and never change when the binding swaps (SC-001).
 */
export function DataAccessProvider({
  impl,
  children,
}: {
  impl?: DataAccess;
  children: ReactNode;
}) {
  const value = impl ?? getDataAccess();
  // Keep the saga accessor in sync without a render-time side effect.
  useEffect(() => {
    if (impl) setDataAccess(impl);
  }, [impl]);
  return <DataAccessContext.Provider value={value}>{children}</DataAccessContext.Provider>;
}

export function useDataAccess(): DataAccess {
  return useContext(DataAccessContext) ?? getDataAccess();
}
