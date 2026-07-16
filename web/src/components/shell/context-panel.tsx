'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

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
  const value = useMemo<ContextPanelValue>(
    () => ({ node, setPanel: setNode, clear: () => setNode(null) }),
    [node],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useContextPanel(): ContextPanelValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useContextPanel must be used within <ContextPanelProvider>');
  return v;
}
