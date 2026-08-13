import { clampPanelWidth, PANEL_MAX, PANEL_MIN } from './panel-divider';

/**
 * W8 (9.9) — the clamp both the drag and the storage read pass through. The drag mechanics are a
 * real-input claim (the live check drags with a real mouse); what jsdom can pin is the RULE: no
 * width outside [min, max] is representable, whatever the pointer or the storage says.
 */
describe('panel width clamp', () => {
  it('holds the floor and the ceiling', () => {
    expect(clampPanelWidth(PANEL_MIN - 100)).toBe(PANEL_MIN);
    expect(clampPanelWidth(PANEL_MAX + 100)).toBe(PANEL_MAX);
    expect(clampPanelWidth(300)).toBe(300);
  });

  it('a corrupt stored value falls back to a sane default, never NaN', () => {
    expect(clampPanelWidth(Number('garbage'))).toBeGreaterThanOrEqual(PANEL_MIN);
    expect(clampPanelWidth(Number('garbage'))).toBeLessThanOrEqual(PANEL_MAX);
  });
});
