import { render, screen, fireEvent } from '@testing-library/react';
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
  it('renders the icon rail and the content', () => {
    renderShell(
      <AppShell>
        <div>Page body</div>
      </AppShell>,
    );

    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByTestId('rail-settings')).toBeInTheDocument();
    expect(screen.getByText('Page body')).toBeInTheDocument();
  });

  /**
   * ⭐ W22 (R40): the chrome LOST two controls, and their absence is asserted rather than assumed.
   * The theme switch and sign-out both moved into settings on the operator's instruction — *«в
   * главном меню её быть не должно»* / *«это как-то слишком легко»*. Without this test the move
   * would be invisible: a duplicate left behind in the top bar looks exactly like a working product.
   * ⚠️ Sign-out's own guarantee (it ends the session ON THE SERVER) did not stay here — it moved to
   * `settings.test.tsx`, in this same change.
   */
  it('⭐ neither the theme switch nor sign-out is anywhere in the chrome any more (R40)', () => {
    renderShell(<AppShell>x</AppShell>);
    expect(screen.queryByRole('button', { name: /toggle theme/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /log ?out|sign ?out/i })).toBeNull();
  });

  it('marks the active route in the nav', () => {
    renderShell(<AppShell>x</AppShell>);
    // usePathname is mocked to `/`, which is the Inbox (FR-001).
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /settings/i })).not.toHaveAttribute('aria-current');
  });

  /**
   * ⭐ W22 (R41). This test used to prove the rail collapses and expands. It now proves the opposite,
   * and the inversion is the requirement: *«всегда эта боковая панель должна быть свёрнута»*, and
   * then *«какой смысл её разворачивать, если… можно просто полное название впихнуть в эти
   * всплывающие окошки»*. Since Шаг 1 the rail is the LIBRARY's Sidebar, so "one width, no control"
   * is asserted the way the library states it — pinned `collapsed` in icon mode — and BEHAVIOURALLY:
   * the one expand path that exists in the DOM (the phone trigger, `md:hidden`) funnels into the
   * shell's controlled no-op, so activating it must change nothing on desktop. A class-name pin
   * (`w-16`) would have outlived the thing it proved.
   */
  it('⭐ the rail is icons-only and has no expand control (R41)', () => {
    renderShell(<AppShell>x</AppShell>);
    const sidebar = screen.getByTestId('sidebar');
    // The library's own vocabulary for W22's requirement: collapsed, icon-collapsible, pinned.
    const wrapper = sidebar.closest('[data-state]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-state', 'collapsed');
    expect(wrapper).toHaveAttribute('data-collapsible', 'icon');
    // The trigger exists only for the phone sheet (hidden ≥ md). On desktop the provider is
    // controlled open={false} with a no-op setter — clicking it must move NOTHING.
    const trigger = screen.getByRole('button', { name: /open navigation/i });
    expect(trigger.className).toMatch(/md:hidden/);
    fireEvent.click(trigger);
    expect(wrapper).toHaveAttribute('data-state', 'collapsed');
    // The label did not disappear with the width — it moved to the hover tip and the accessible name.
    expect(screen.getByRole('link', { name: /inbox/i })).toHaveAttribute('aria-label', 'Inbox');
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

  it('a permissioned module follows its key; PERSONAL settings need none (amended by W18)', () => {
    // ⚠️ This test used to gate the Settings link on `platform.settings.manage` — the misreading
    // W18 corrected: that entry is the operator's OWN settings shell (ADR 0035), on every rail by
    // R26's own words; tenant configuration lives behind the Admin Center's gate. The permissioned
    // claim is kept — asserted on Contacts, which genuinely follows a key.
    const withKey = renderWith(['crm.inbox.view', 'crm.customers.browse']);
    expect(screen.getByRole('link', { name: /contacts/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    withKey.unmount();

    renderWith(['crm.inbox.view']);
    expect(screen.queryByRole('link', { name: /contacts/i })).not.toBeInTheDocument();
    // …and the positive controls: the rail rendered, and the personal entry survives the key loss.
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('⚠️ no permissions renders no privileged links at all (deny-by-default)', () => {
    renderWith([]);
    expect(screen.queryByRole('link', { name: /inbox/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /contacts/i })).not.toBeInTheDocument();
    // The personal settings shell grants nothing and stays — it is the caller's own theme.
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('⭐ R13: the reserved telephony slot is absent by configuration, not deleted from the product', () => {
    renderWith(['crm.inbox.view', 'platform.settings.manage']);
    expect(screen.queryByRole('link', { name: /telephony/i })).not.toBeInTheDocument();
    // The catalogue still carries it — `module-states.test.tsx` asserts that, and it is what makes
    // "bring it back" a configuration value rather than a code change.
  });
});
