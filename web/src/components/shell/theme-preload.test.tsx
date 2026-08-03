import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { ThemeToggle } from './theme-toggle';

/**
 * T039 (feature 029 — roadmap 9.1's missing criteria, FR-022).
 *
 * **The theme is applied before first paint, and the choice persists per person.**
 *
 * ⚠️⚠️ **What this file can and cannot prove.** "No flash of the wrong theme" is a claim about what a
 * human sees in the first ~50 ms of a real page load. jsdom does not paint, so no assertion here can
 * establish it. What is asserted instead is the MECHANISM that makes it true — the class-attribute
 * strategy that lets a synchronous script set `.dark` on `<html>` before the body renders, and the
 * `suppressHydrationWarning` that strategy requires.
 *
 * ⇒ The visual claim belongs in a browser. It is listed in `quickstart.md` under Track B, and if it
 * cannot be run there it must report itself as not-run rather than pass quietly.
 */
const APP_DIR = join(__dirname, '..', '..', '..', 'app');

describe('*** the mechanism that prevents a flash of the wrong theme (FR-022) ***', () => {
  const providers = readFileSync(join(APP_DIR, 'providers.tsx'), 'utf8');
  const layout = readFileSync(join(APP_DIR, 'layout.tsx'), 'utf8');

  it('the theme is applied as a CLASS on the document element', () => {
    // The class strategy is what a pre-paint inline script can set. A React-state-driven theme cannot
    // be applied before the first paint by construction — the paint happens first.
    expect(providers).toMatch(/attribute=["']class["']/);
  });

  it('the document element suppresses hydration warnings — required by that strategy', () => {
    // The pre-paint script mutates <html> before React hydrates, so server and client markup differ
    // by design. Without this, the strategy produces a console error on every load and the next
    // person "fixes" it by removing the pre-paint script.
    expect(layout).toMatch(/<html[^>]*suppressHydrationWarning/);
  });

  it('the theme provider wraps the whole tree, above the app shell', () => {
    // A provider mounted inside a screen would leave the chrome unthemed on first paint.
    const themeIndex = providers.indexOf('ThemeProvider');
    const sessionIndex = providers.indexOf('SessionProvider');
    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeGreaterThan(themeIndex);
  });

  it('⚠️ NOTE — the visual "no flash" claim is not proven here', () => {
    // Deliberately a passing test with a visible name rather than a silent omission: a reader
    // scanning this file must see that the pixel claim was moved, not forgotten (quickstart B6).
    expect(true).toBe(true);
  });
});

describe('*** the choice persists (FR-022) ***', () => {
  afterEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  function renderToggle() {
    return render(
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <ThemeToggle />
      </ThemeProvider>,
    );
  }

  it('flipping the theme writes the choice to storage', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    renderToggle();
    fireEvent.click(screen.getByRole('button', { name: /toggle theme/i }));

    expect(setItem).toHaveBeenCalled();
    const wroteTheme = setItem.mock.calls.some(([, value]) => value === 'dark' || value === 'light');
    expect(wroteTheme).toBe(true);
  });

  it('the toggle is reachable by its accessible name, not by a colour', () => {
    renderToggle();
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
  });
});
