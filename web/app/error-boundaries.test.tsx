import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import DashboardError from './(dashboard)/error';

/**
 * ⭐⭐ **The application must never fail to a blank page.**
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────────
 * There was no error boundary anywhere: no `error.tsx`, no `global-error.tsx`, no `componentDidCatch`.
 * So one uncaught render error unmounted the entire React tree and the operator got an **empty
 * `<body>`** — no message, dead clicks, dead scrolling, an empty console, and DevTools showing
 * nothing to select. It was reported as "the site hangs", and a crash and a freeze need opposite
 * fixes, so three rounds of diagnosis went to the wrong one.
 *
 * ⇒ A blank page is the worst failure mode available, because it **destroys the evidence**. These
 * tests exist to keep the evidence on screen.
 */
describe('*** the app has error boundaries at all (the absence WAS the defect) ***', () => {
  it('⭐ a dashboard-level boundary exists', () => {
    expect(existsSync(join(__dirname, '(dashboard)', 'error.tsx'))).toBe(true);
  });

  it('⭐ a root-level boundary exists, for a failure in the shell itself', () => {
    expect(existsSync(join(__dirname, 'global-error.tsx'))).toBe(true);
  });
});

describe('*** a caught error is SHOWN, not swallowed ***', () => {
  const error = Object.assign(new TypeError('Cannot read properties of undefined (reading "map")'), {
    digest: 'abc123',
  });

  it('names the error on screen so it can be read off and reported', () => {
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByTestId('dashboard-error')).toBeInTheDocument();
    expect(screen.getByText(/Cannot read properties of undefined/)).toBeInTheDocument();
    expect(screen.getByText(/TypeError/)).toBeInTheDocument();
  });

  it('shows the digest, which is the only handle on a server-side failure', () => {
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });

  it('offers recovery without a full reload, and an escape to the Inbox', () => {
    const reset = jest.fn();
    render(<DashboardError error={error} reset={reset} />);
    screen.getByRole('button', { name: /try again/i }).click();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /back to the inbox/i })).toBeInTheDocument();
  });

  it('⚠️ renders something visible even for an error with no message at all', () => {
    // A blank message must not produce a blank screen — that is the original defect in miniature.
    render(<DashboardError error={new Error('')} reset={() => {}} />);
    const shown = screen.getByTestId('dashboard-error').textContent ?? '';
    expect(shown.length).toBeGreaterThan(40);
    expect(shown).toMatch(/failed to render/i);
  });
});
