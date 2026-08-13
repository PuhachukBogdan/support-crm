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

/**
 * W26 (R42) — which slide-out panel is OPEN, held here rather than in the pushed node.
 *
 * ── Why a SECOND context instead of a field on the slot ─────────────────────────────────────────
 * Two different lifetimes. The NODE is per-screen: the ticket window pushes a fresh element for each
 * ticket and clears it on unmount. The CHOICE must be longer-lived than any node — *«состояние
 * "панель открыта" переживает переход между тикетами»* — so it cannot live inside the pushed
 * component (a new ticket = a new element = state reset to the default, which is exactly the reset
 * the block forbids).
 *
 * And two different audiences. The shell reads the NODE (to render the slot); only the panel itself
 * reads the CHOICE. Folding both into one context would re-render the whole shell on every
 * open/close click — the render-storm direction W6/W10 paid for. Separate contexts mean a toggle
 * re-renders the panel subtree and nothing above it.
 */
type PanelChoiceValue = {
  /** `null` = every panel closed; the icon rail alone shows (the left rail's own resting shape). */
  openId: string | null;
  /** Same id again closes — the operator's «нажимаешь — выезжает, повторно — убирается». */
  toggle: (id: string) => void;
  close: () => void;
};

const ChoiceCtx = createContext<PanelChoiceValue | null>(null);

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

  // The choice, with the same stability rule as setPanel/clear above: functional updates, no deps,
  // so a consumer effect can list these without re-firing (the 2026-08-06 loop).
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => setOpenId((cur) => (cur === id ? null : id)), []);
  const close = useCallback(() => setOpenId(null), []);
  const choice = useMemo<PanelChoiceValue>(() => ({ openId, toggle, close }), [openId, toggle, close]);

  return (
    <Ctx.Provider value={value}>
      <ChoiceCtx.Provider value={choice}>{children}</ChoiceCtx.Provider>
    </Ctx.Provider>
  );
}

export function useContextPanel(): ContextPanelValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useContextPanel must be used within <ContextPanelProvider>');
  return v;
}

export function usePanelChoice(): PanelChoiceValue {
  const v = useContext(ChoiceCtx);
  if (!v) throw new Error('usePanelChoice must be used within <ContextPanelProvider>');
  return v;
}
