import { render } from '@testing-library/react';
import { StaleBuildRecovery, isChunkLoadFailure } from './stale-build-recovery';

/**
 * A tab open across a deployment recovers itself — once (observed live 2026-08-02).
 *
 * The detector is tested against the real browser messages AND against ordinary errors, because the
 * dangerous mistake here is a matcher that is too wide: reloading on any error would hide genuine
 * application bugs behind a page refresh, and they would never be reported.
 */
describe('the chunk-failure detector', () => {
  it('⭐ fires on the messages browsers actually produce for a missing chunk', () => {
    for (const message of [
      'ChunkLoadError: Loading chunk 429 failed.',
      'Loading chunk 12 failed. (missing: https://host/_next/static/chunks/12-abc.js)',
      'Failed to fetch dynamically imported module: https://host/_next/static/chunks/app/page-9f3.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
    ]) {
      expect(isChunkLoadFailure(message)).toBe(true);
    }
  });

  it('⛔ does NOT fire on ordinary application errors — a reload would hide them', () => {
    for (const message of [
      "Cannot read properties of undefined (reading 'map')",
      'Network request failed',
      'Unexpected token < in JSON at position 0',
      'The user aborted a request.',
      '',
    ]) {
      expect(isChunkLoadFailure(message)).toBe(false);
    }
  });
});

describe('*** recovery happens once, never in a loop ***', () => {
  const reload = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  function fireChunkError() {
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ChunkLoadError: Loading chunk 7 failed.' }),
    );
  }

  it('reloads on a chunk failure', () => {
    render(<StaleBuildRecovery />);
    fireChunkError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('⭐ does NOT reload a second time — a loop hides the real fault and burns the tab', () => {
    render(<StaleBuildRecovery />);
    fireChunkError();
    fireChunkError();
    fireChunkError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores an ordinary error', () => {
    render(<StaleBuildRecovery />);
    window.dispatchEvent(new ErrorEvent('error', { message: 'something else went wrong' }));
    expect(reload).not.toHaveBeenCalled();
  });

  it('an OLD marker is cleared on a successful load, so the next deployment can recover too', () => {
    window.sessionStorage.setItem('crm:stale-build-reload', String(Date.now() - 120_000));
    render(<StaleBuildRecovery />);
    fireChunkError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a RECENT marker still suppresses — that is the loop guard doing its job', () => {
    window.sessionStorage.setItem('crm:stale-build-reload', String(Date.now()));
    render(<StaleBuildRecovery />);
    fireChunkError();
    expect(reload).not.toHaveBeenCalled();
  });

  it('recovers from an unhandled promise rejection too (dynamic import failures arrive that way)', () => {
    render(<StaleBuildRecovery />);
    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('Failed to fetch dynamically imported module: /_next/x.js');
    window.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
