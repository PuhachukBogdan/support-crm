import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Шаг 1 (9.9) — the ticket window's seam is the LIBRARY's Resizable, wired with constraints.
 *
 * The hand-made `panel-divider.tsx` (px clamp, own localStorage) is retired; what jsdom can pin
 * now is the WIRING — the window composes the library seam with min/max on the panel and a
 * persistence id, so no edit can quietly ship a seam a drag can break or one that forgets.
 * The drag itself stays a real-input claim: the live check drags with a real mouse
 * (`deploy/local/w7-browser-check.mjs`), because layout does not exist in jsdom.
 */
const src = readFileSync(join(__dirname, 'ticket-window.tsx'), 'utf8');

describe('the seam is the library, with its constraints wired (9.9)', () => {
  it('composes ResizablePanelGroup/Panel/Handle — not a hand-made divider', () => {
    expect(src).toContain('<ResizablePanelGroup');
    expect(src).toContain('<ResizablePanel');
    expect(src).toContain('<ResizableHandle');
    expect(src).not.toMatch(/PanelDivider|useStoredPanelWidth/);
  });

  it('the fields panel carries min AND max — no drag can produce an unusable layout', () => {
    expect(src).toMatch(/minSize=\{\d+\}/);
    expect(src).toMatch(/maxSize=\{\d+\}/);
  });

  it('the layout persists (autoSaveId) and the handle keeps its name for checks and readers', () => {
    expect(src).toMatch(/autoSaveId="crm\.ticket\.seam"/);
    expect(src).toContain('data-testid="panel-divider"');
    expect(src).toContain('aria-label="Resize the properties column"');
  });
});
