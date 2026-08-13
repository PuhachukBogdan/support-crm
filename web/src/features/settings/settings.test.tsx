import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { Providers } from '../../../app/providers';
import { Settings } from './settings';
import { resetThemeSyncForTests } from './use-theme-mode';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort } from '@/data/gateway/http-port';

/**
 * ⚠️ W22: `Settings` now NAVIGATES (sign-out sends you to /login), so its tests need a router where
 * they previously needed none. Mocked here rather than in each test, because the requirement is a
 * property of the screen, not of one case.
 */
const routerPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => '/settings',
}));

/**
 * W18 — the personal settings shell + the persisted theme (5.2 + 5.3). Shape claims: the stored
 * value is APPLIED on mount (the server is the cross-machine truth), a flip WRITES THROUGH
 * (`{values:{theme_mode}}` on the singleton), a failed save keeps the flip and says so, and the
 * two reserved categories carry their owning points.
 */

interface Stub extends DataAccess {
  updates: Array<{ resource: string; id: string; patch: unknown }>;
  creates: Array<{ resource: string; input: unknown }>;
}

function stub(opts: { stored?: string; updateFails?: boolean } = {}): Stub {
  const updates: Stub['updates'] = [];
  const creates: Stub['creates'] = [];
  return {
    updates,
    creates,
    async list(): Promise<never> {
      throw new Error('not used');
    },
    async get<T = unknown>(resource: string): Promise<T> {
      if (resource === 'ui-preferences') return { values: { theme_mode: opts.stored ?? 'light' } } as T;
      if (resource === 'me-operator') return { operatorId: 'op-1', displayName: 'Ann', avatarUploadId: '' } as T;
      if (resource === 'my-presence') return { state: 'online' } as T;
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: string, input: unknown): Promise<T> {
      creates.push({ resource, input });
      return { id: 'up-77' } as T;
    },
    async update<T = unknown>(resource: string, id: string, patch: unknown): Promise<T> {
      updates.push({ resource, id, patch });
      if (opts.updateFails) throw { message: 'Something went wrong. Please try again.', retryable: true };
      if (resource === 'my-avatar') return { operatorId: 'op-1', displayName: 'Ann', avatarUploadId: 'up-77' } as T;
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
    await waitFor(() =>
      expect(s.updates.filter((u) => u.resource === 'ui-preferences')).toHaveLength(1),
    );
    expect(s.updates.find((u) => u.resource === 'ui-preferences')).toMatchObject({
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

describe('5.2 — the shell: categories, owners on what stays reserved', () => {
  it('Accessibility stays reserved WITH its point; Profile became real in W19', async () => {
    renderSettings(stub());
    await screen.findByTestId('settings-ui');
    expect(screen.getByTestId('settings-accessibility')).toHaveTextContent('8.9');
    // The one decision worth saying on the screen: the name is not editable.
    expect(await screen.findByTestId('settings-profile')).toHaveTextContent('not editable by');
  });
});

describe('W19 — the Profile section (5.4 avatar + 5.5 presence)', () => {
  it('⭐ the avatar is TWO writes: the bytes to /uploads/avatar, then the ID onto my profile', async () => {
    const s = stub();
    renderSettings(s);
    const input = (await screen.findByTestId('avatar-file')) as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(s.updates.some((u) => u.resource === 'my-avatar')).toBe(true));
    expect(s.creates[0]!.resource).toBe('avatar-uploads');
    expect(s.creates[0]!.input).toBeInstanceOf(FormData);
    // The wire has Upload.id — W7's live run caught a hook inventing `uploadId` here.
    expect(s.updates.find((u) => u.resource === 'my-avatar')).toMatchObject({
      id: '',
      patch: { uploadId: 'up-77' },
    });
    // The receipt: the 256px derivative renders, never the original.
    const img = (await screen.findByTestId('avatar-image')) as HTMLImageElement;
    expect(img.src).toContain('/uploads/up-77/thumb');
  });

  it('⭐ Break PUTs `away` on MY presence singleton, and says what break MEANS for routing', async () => {
    const s = stub();
    renderSettings(s);
    fireEvent.click(await screen.findByTestId('presence-away'));
    await waitFor(() => expect(s.updates.some((u) => u.resource === 'my-presence')).toBe(true));
    expect(s.updates.find((u) => u.resource === 'my-presence')).toMatchObject({
      id: '',
      patch: { state: 'away' },
    });
    expect(await screen.findByTestId('presence-note')).toHaveTextContent('not routed to you');
  });
});

/**
 * ⭐ W22 (R40) — THE SIGN-OUT GUARANTEE, MOVED HERE WITH ITS BUTTON.
 *
 * This assertion lived in `shell.test.tsx` while the control lived in the top bar. The operator moved
 * the control — *«я думаю, logout сделать именно в настройках аккаунта, потому что в той всплывающей
 * панели… это как-то слишком легко»* — and the check moved in the same change, deliberately.
 *
 * What it protects has not changed and is the whole reason it exists: the ORIGINAL handler flipped a
 * local flag and navigated, which is not a sign-out at all — the cookie kept working everywhere it
 * had already been sent, and nothing on the server knew. So the claim is asserted **on the wire**,
 * because "we called logout" is exactly what was false before.
 *
 * ⚠️ A check that stays behind when its subject moves is how a guarantee evaporates while every file
 * still looks correct. Third time this project has had to say it (W8, W16, now).
 */
describe('W22 — account: signing out', () => {
  it('⭐ ends the session ON THE SERVER, not by flipping a local flag', async () => {
    /**
     * Asserted ON THE WIRE, and that is deliberate: the original handler flipped a local flag and
     * navigated, so a test that only proved "we called signOut" would have passed against the very
     * bug this exists to catch. The request is the evidence.
     */
    const sent: string[] = [];
    const port: HttpPort = async (req) => {
      sent.push(req.path);
      return { status: 200, body: { status: 'logged_out' } };
    };

    routerPush.mockClear();
    setDataAccess(stub());
    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <SessionProvider impl={new GatewaySession(port)} seed={{ kind: 'authenticated', permissionKeys: [] } as never}>
          <Settings />
        </SessionProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByTestId('sign-out'));

    await waitFor(() => expect(sent).toContain('/auth/logout'));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
  });
});
