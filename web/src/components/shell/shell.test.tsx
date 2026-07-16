import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ThemeProvider } from 'next-themes';
import { ContextPanelProvider } from './context-panel';
import { AppShell } from './app-shell';

// next/navigation isn't available in jsdom — mock the two hooks the shell uses.
jest.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
  useRouter: () => ({ push: jest.fn() }),
}));

function renderShell(ui: ReactNode) {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light">
      <ContextPanelProvider>{ui}</ContextPanelProvider>
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

  it('hardcodes no hex colors (white-label)', () => {
    const { container } = renderShell(<AppShell>x</AppShell>);
    expect(container.innerHTML + document.body.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
