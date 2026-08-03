import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ThemeProvider } from 'next-themes';
import { ContextPanelProvider } from './context-panel';
import { AppShell } from './app-shell';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort } from '@/data/gateway/http-port';

// next/navigation isn't available in jsdom — mock the two hooks the shell uses.
jest.mock('next/navigation', () => ({
  // Feature 029: the Inbox is the landing route, so "the current page" is `/`, not `/inbox`.
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * The topbar's sign-out now goes through the session boundary (feature 027), so the shell needs a
 * provider. Seeded `authenticated` and given a port that answers nothing: this suite is about the
 * shell's chrome, and a shell test that also exercised the network would fail for reasons that have
 * nothing to do with the shell.
 */
/**
 * Feature 029: the rail is assembled from the caller's permissions, so these tests must grant the
 * ones whose links they assert on. ⚠️ An empty set is now the correct way to render almost no rail —
 * that is deny-by-default working, not a broken fixture.
 */
const SIGNED_IN = {
  kind: 'authenticated',
  userId: 'u1',
  accountId: 'a1',
  roles: [],
  permissionKeys: ['crm.inbox.view', 'platform.settings.manage'],
} as const;
const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

function renderShell(ui: ReactNode) {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light">
      <SessionProvider impl={new GatewaySession(silentPort)} seed={SIGNED_IN}>
        <ContextPanelProvider>{ui}</ContextPanelProvider>
      </SessionProvider>
    </ThemeProvider>,
  );
}

describe('S3 app shell', () => {
  it('renders sidebar nav, content, and the theme toggle', () => {
    renderShell(
      <AppShell>
        <div>Page body</div>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    expect(screen.getByText('Page body')).toBeInTheDocument();
  });

  it('marks the active route in the nav', () => {
    renderShell(<AppShell>x</AppShell>);
    // usePathname is mocked to `/`, which is the Inbox (FR-001).
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /settings/i })).not.toHaveAttribute('aria-current');
  });

  it('collapses and expands the sidebar', () => {
    renderShell(<AppShell>x</AppShell>);
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.className).toMatch(/w-60/);

    fireEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    expect(sidebar.className).toMatch(/w-16/);
  });

  it('opens the command palette on Cmd/Ctrl+K', () => {
    renderShell(<AppShell>x</AppShell>);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByPlaceholderText(/type a command or search/i)).toBeInTheDocument();
  });

  it('⭐ signing out ends the session ON THE SERVER (T027, FR-005)', async () => {
    // The old handler flipped a local flag and navigated. That is not a sign-out: the cookie kept
    // working everywhere it had already been sent, and nothing on the server knew anything had
    // happened. Asserted on the wire, because "we called logout" is exactly what was false before.
    const sent: string[] = [];
    const port: HttpPort = async (req) => {
      sent.push(req.path);
      return { status: 200, body: { status: 'logged_out' } };
    };
    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <SessionProvider impl={new GatewaySession(port)} seed={SIGNED_IN}>
          <ContextPanelProvider>
            <AppShell>x</AppShell>
          </ContextPanelProvider>
        </SessionProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(sent).toContain('/auth/logout'));
  });

  it('hardcodes no hex colors (white-label)', () => {
    const { container } = renderShell(<AppShell>x</AppShell>);
    expect(container.innerHTML + document.body.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

/**
 * T042 (feature 029, FR-020) — the RENDERED rail follows the caller's permissions.
 *
 * `module-states.test.tsx` proves the resolution rule; this proves the shell actually applies it.
 * Both are needed: a correct rule that nothing calls is the shape of several defects in this
 * repository's history.
 */
describe('*** the rail is rendered from server-resolved permissions (FR-020) ***', () => {
  function renderWith(permissionKeys: string[]) {
    const seed = {
      kind: 'authenticated',
      userId: 'u1',
      accountId: 'a1',
      roles: [],
      permissionKeys,
    } as const;
    return render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
          <ContextPanelProvider>
            <AppShell>x</AppShell>
          </ContextPanelProvider>
        </SessionProvider>
      </ThemeProvider>,
    );
  }

  it('a settings permission produces a Settings link; its absence removes it', () => {
    const withSettings = renderWith(['crm.inbox.view', 'platform.settings.manage']);
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    withSettings.unmount();

    renderWith(['crm.inbox.view']);
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
    // …and the positive control: the rail did render, so the absence means something.
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
  });

  it('⚠️ no permissions renders no privileged links at all (deny-by-default)', () => {
    renderWith([]);
    expect(screen.queryByRole('link', { name: /inbox/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('⭐ R13: the reserved telephony slot is absent by configuration, not deleted from the product', () => {
    renderWith(['crm.inbox.view', 'platform.settings.manage']);
    expect(screen.queryByRole('link', { name: /telephony/i })).not.toBeInTheDocument();
    // The catalogue still carries it — `module-states.test.tsx` asserts that, and it is what makes
    // "bring it back" a configuration value rather than a code change.
  });
});
