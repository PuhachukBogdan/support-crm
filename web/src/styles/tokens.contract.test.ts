import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * S0 token-contract guard (roadmap 1.6 / ADR 0031).
 *
 * The token contract is the white-label seam: components consume semantic roles,
 * a brand later swaps only the values. This test freezes the CONTRACT — the set of
 * semantic roles + scales that must exist in both light and dark — and enforces the
 * white-label invariant (no hardcoded hex colors). It fails if a role is dropped,
 * if dark mode forgets a role, or if a raw hex color sneaks in.
 */

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

// Split into the light scope (everything outside `.dark { … }`) and the dark block.
const darkBlock = (() => {
  const start = css.indexOf('.dark {');
  if (start === -1) return '';
  const from = css.indexOf('{', start);
  return css.slice(from + 1, css.indexOf('}', from));
})();
const lightScope = css.replace(darkBlock, '');

// Semantic roles every component may rely on — must be themed in BOTH light and dark.
const SEMANTIC_ROLES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
];

// Non-color scales the contract promises (shared; declared once).
const SCALE_TOKENS = [
  'radius',
  'font-sans',
  'text-base',
  'space-gutter',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'motion-base',
  'ease-standard',
  'z-sticky',
  'z-dropdown',
  'z-drawer',
  'z-dialog',
  'z-popover',
  'z-command',
  'z-toast',
];

describe('S0 design-token contract', () => {
  it('declares both a :root scope and a .dark scope', () => {
    expect(css).toMatch(/:root\s*\{/);
    expect(darkBlock.length).toBeGreaterThan(0);
  });

  it.each(SEMANTIC_ROLES)('themes the "%s" role in light mode', (role) => {
    expect(lightScope).toMatch(new RegExp(`--${role}\\s*:`));
  });

  it.each(SEMANTIC_ROLES)('themes the "%s" role in dark mode', (role) => {
    expect(darkBlock).toMatch(new RegExp(`--${role}\\s*:`));
  });

  it.each(SCALE_TOKENS)('defines the "%s" scale token', (token) => {
    expect(css).toMatch(new RegExp(`--${token}\\s*:`));
  });

  it('hardcodes no hex colors (white-label invariant — HSL channels only)', () => {
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(hex).toBeNull();
  });
});
