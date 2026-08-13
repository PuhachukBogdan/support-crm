'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// Right-hand context-panel SLOT. A screen fills it via useContextPanel().setPanel(node);
// the shell renders it only when non-empty. Screens never touch the shell layout itself.
type ContextPanelValue = {
  node: ReactNode;
  setPanel: (node: ReactNode) => void;
  clear: () => void;
};

const Ctx = createContext<ContextPanelValue | null>(null);

export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null);
  /**
   * ⚠️⚠️ **`clear` MUST be stable, and this is not tidying — W10's first consumer hung on it.**
   *
   * The natural way to fill this slot is an effect: `setPanel(<Panel/>)` on mount, `clear()` on
   * unmount. But an inline `clear` was a NEW function on every provider render, and `setPanel`
   * changes the provider's own state — so the sequence was: effect runs → node changes → provider
   * re-renders → `clear` has a new identity → the effect's deps changed → effect runs again →
   * a new element, a new node, for ever. jsdom caught it as a test that never finished; in a
   * browser it is the freeze class this project spent 2026-08-06 removing from the Inbox.
   *
   * `useCallback` with no deps makes both identities constant for the provider's whole life, so a
   * consumer's effect fires only when its OWN inputs change. The `node` in the memo below still
   * changes per push — that is the point of the slot — but nothing depends on it except the shell.
   */
  const setPanel = useCallback((next: ReactNode) => setNode(next), []);
  const clear = useCallback(() => setNode(null), []);
  const value = useMemo<ContextPanelValue>(() => ({ node, setPanel, clear }), [node, setPanel, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useContextPanel(): ContextPanelValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useContextPanel must be used within <ContextPanelProvider>');
  return v;
}
