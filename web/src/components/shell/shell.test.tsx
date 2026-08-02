import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ThemeProvider } from 'next-themes';
import { ContextPanelProvider } from './context-panel';
import { AppShell } from './app-shell';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort } from '@/data/gateway/http-port';

// next/navigation isn't available in jsdom — mock the two hooks the shell uses.
jest.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * The topbar's sign-out now goes through the session boundary (feature 027), so the shell needs a
 * provider. Seeded `authenticated` and given a port that answers nothing: this suite is about the
 * shell's chrome, and a shell test that also exercised the network would fail for reasons that have
 * nothing to do with the shell.
 */
const SIGNED_IN = { kind: 'authenticated', userId: 'u1', accountId: 'a1', roles: [] } as const;
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
    // usePathname is mocked to /inbox.
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
