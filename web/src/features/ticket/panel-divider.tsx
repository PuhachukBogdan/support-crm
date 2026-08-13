'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * W8 (roadmap 9.9) — the resizable seam between the ticket window's panels.
 *
 * The two hard requirements are 9.9's own words, and both are shapes this repo has already been
 * burned by:
 *  · **never a React render per pixel** — during the drag the width is written as ONE style
 *    property on ONE element (direct DOM), and React state is committed once, on release;
 *  · min/max on every panel, so no drag can produce an unusable layout.
 *
 * The width persists in `localStorage` for now. ⚠️ 9.9 wants it stored per USER (5.6) — that is
 * W18's settings machinery; when it lands, this key's read/write moves behind it. Recorded here so
 * the migration is a search for the constant, not an archaeology dig.
 */
export const PANEL_MIN = 200;
export const PANEL_MAX = 480;
const STORAGE_KEY = 'crm.ticket.fields-width';
const DEFAULT_WIDTH = 256;

/** The one clamp both the drag and the storage read go through. */
export function clampPanelWidth(width: number): number {
  if (Number.isNaN(width)) return DEFAULT_WIDTH;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));
}

export interface PanelWidthHandle {
  ref: React.RefObject<HTMLDivElement | null>;
  width: number;
  commit: (width: number) => void;
}

export function useStoredPanelWidth(): PanelWidthHandle {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH;
    return clampPanelWidth(Number(window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_WIDTH));
  });
  const commit = useCallback((next: number) => {
    const clamped = clampPanelWidth(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Storage can be full or blocked; the layout still works, it just forgets.
    }
  }, []);
  return { ref, width, commit };
}

/** The drag handle. Pointer capture keeps the drag alive when the cursor outruns the 6px strip. */
export function PanelDivider({ target }: { target: PanelWidthHandle }) {
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = target.ref.current;
    if (!el) return;
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = el.getBoundingClientRect().width;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic PointerEvent (dispatched by a check) has no capturable pointer — the window
      // listeners below carry the drag regardless; capture is comfort, not correctness.
    }

    const move = (ev: PointerEvent) => {
      if (!dragging.current) return;
      // Direct style write — the whole point. React hears nothing until release.
      el.style.width = `${clampPanelWidth(startWidth + (ev.clientX - startX))}px`;
    };
    const up = (ev: PointerEvent) => {
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      target.commit(startWidth + (ev.clientX - startX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the properties column"
      data-testid="panel-divider"
      onPointerDown={onPointerDown}
      className="w-1.5 shrink-0 cursor-col-resize rounded bg-transparent hover:bg-border active:bg-border"
    />
  );
}
