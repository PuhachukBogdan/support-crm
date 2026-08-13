import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { Providers } from '../../../app/providers';
import { Settings } from './settings';
import { resetThemeSyncForTests } from './use-theme-mode';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';

/**
 * W18 — the personal settings shell + the persisted theme (5.2 + 5.3). Shape claims: the stored
 * value is APPLIED on mount (the server is the cross-machine truth), a flip WRITES THROUGH
 * (`{values:{theme_mode}}` on the singleton), a failed save keeps the flip and says so, and the
 * two reserved categories carry their owning points.
 */

interface Stub extends DataAccess {
  updates: unknown[];
}

function stub(opts: { stored?: string; updateFails?: boolean } = {}): Stub {
  const updates: unknown[] = [];
  return {
    updates,
    async list(): Promise<never> {
      throw new Error('not used');
    },
    async get<T = unknown>(): Promise<T> {
      return { values: { theme_mode: opts.stored ?? 'light' } } as T;
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async update<T = unknown>(resource: string, id: string, patch: unknown): Promise<T> {
      updates.push({ resource, id, patch });
      if (opts.updateFails) throw { message: 'Something went wrong. Please try again.', retryable: true };
      return {} as T;
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('not used');
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderSettings(s: Stub) {
  resetThemeSyncForTests();
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <Settings />
      </ThemeProvider>
    </Providers>,
  );
}

describe('5.3 — the theme follows the person', () => {
  it('⭐ the STORED value is applied on mount — the server wins over the local cache', async () => {
    renderSettings(stub({ stored: 'dark' }));
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
  });

  it('⭐ a flip writes through: {values: {theme_mode}} on the ui-preferences singleton', async () => {
    const s = stub({ stored: 'light' });
    renderSettings(s);
    fireEvent.click(await screen.findByTestId('theme-dark'));
    await waitFor(() => expect(s.updates).toHaveLength(1));
    expect(s.updates[0]).toMatchObject({
      resource: 'ui-preferences',
      id: '',
      patch: { values: { theme_mode: 'dark' } },
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('a failed save KEEPS the flip and says so — dark now, honest about the next machine', async () => {
    renderSettings(stub({ updateFails: true }));
    fireEvent.click(await screen.findByTestId('theme-dark'));
    expect(await screen.findByTestId('theme-save-error')).toHaveTextContent('could not be saved');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('5.2 — the shell: three categories, one real control, owners on the slots', () => {
  it('Accessibility and Profile are reserved WITH their points — a slot with no owner stays reserved forever', async () => {
    renderSettings(stub());
    await screen.findByTestId('settings-ui');
    expect(screen.getByTestId('settings-accessibility')).toHaveTextContent('8.9');
    expect(screen.getByTestId('settings-profile')).toHaveTextContent('W19');
    // The one decision worth saying on the screen: the name is not editable.
    expect(screen.getByTestId('settings-profile')).toHaveTextContent('name is not editable');
  });
});
