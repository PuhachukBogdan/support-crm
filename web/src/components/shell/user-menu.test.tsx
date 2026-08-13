import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import { ContextPanelProvider } from './context-panel';
import { AppShell } from './app-shell';
import { UserMenu } from './user-menu';
import { SessionProvider, GatewaySession } from '@/session';
import { DataAccessProvider } from '@/data/provider';
import type { HttpPort } from '@/data/gateway/http-port';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';
import { PRESENCE_CHOICES } from '@/data/presence';

/**
 * ⭐⭐ W22 / R40 — the user's own window in the rail's FOOTER, and the STATUSES in it.
 *
 * The operator asked for this twice. First on his reference frame: *«это, по сути, вообще окно юзера…
 * как минимум там можно выставить свой статус, перейти в настройки своего аккаунта»*, present on every
 * screen and for every role — *«не только саппорта, но и VIP-менеджера, и админа»*. Then again on
 * 2026-08-10, after using the product: *«настройки профиля… сейчас находятся именно в Settings.
 * Можешь, пожалуйста, всё-таки имплементировать фичу, которую мы хотели сделать? То есть вот это
 * окошко с, типа, как профилем, и там были статусы»*.
 *
 * ── Why the presence half is the load-bearing half ──────────────────────────────────────────────
 * ⚠️ Presence decides whether WORK REACHES THIS PERSON. The router (feature 031) reads the same store
 * this control writes, which is what makes *«на перерыве — тикеты не приходят»* one fact rather than
 * two. So a control that appears to change the state and does not is not a cosmetic defect: it is a
 * person who believes they are on a break while the queue keeps filling their inbox.
 *
 * ⓘ The product had been offering TWO of the server's four states (on the settings page), so this is
 * capability that had no control rather than new capability. The four are asserted against
 * `@/data/presence` — the one place they are spelled — so a fifth state added to the server surfaces
 * as a failure here instead of as a menu that silently omits it.
 */

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}));

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

const SIGNED_IN = {
  kind: 'authenticated',
  userId: 'u1',
  accountId: 'a1',
  roles: [],
  permissionKeys: ['crm.inbox.view', 'platform.settings.manage'],
} as const;

interface StubOptions {
  presence?: string;
  /** The label the server says is active — the reason behind the state (W22-доп). */
  labelId?: string;
  /** The account's presets, as `GET /presence/labels` would list them. Default: none. */
  presets?: { id: string; name: string; state: string }[];
  displayName?: string;
  avatarUploadId?: string;
  /** `PUT /presence/me` fails — the optimistic badge must go BACK. */
  failPresenceWith?: unknown;
  /** `/me/operator` fails — the menu still renders (it is chrome, not a page). */
  failOperator?: boolean;
}

interface Stub extends DataAccess {
  writes: { resource: ResourceName; payload: unknown }[];
}

function stub(opts: StubOptions = {}): Stub {
  const s: Stub = {
    writes: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'presence-labels') {
        return { items: (opts.presets ?? []) as T[], nextCursor: null, hasMore: false };
      }
      return { items: [], nextCursor: null, hasMore: false };
    },
    async get<T = unknown>(resource: ResourceName): Promise<T> {
      if (resource === 'me-operator') {
        if (opts.failOperator) throw { message: 'nope', retryable: true };
        return {
          operatorId: 'op-me',
          displayName: opts.displayName ?? 'Nina Petrova',
          avatarUploadId: opts.avatarUploadId ?? '',
        } as unknown as T;
      }
      if (resource === 'my-presence') {
        return { state: opts.presence ?? 'online', labelId: opts.labelId ?? '' } as unknown as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('no creates here');
    },
    async update<T = unknown>(resource: ResourceName, _id: string, patch: unknown): Promise<T> {
      s.writes.push({ resource, payload: patch });
      if (resource === 'my-presence' && opts.failPresenceWith) throw opts.failPresenceWith;
      return {} as T;
    },
    async remove<T = void>(): Promise<T> {
      return undefined as T;
    },
    subscribe(): () => void {
      return () => {};
    },
  };
  return s;
}

function renderMenu(opts: StubOptions = {}) {
  const s = stub(opts);
  render(
    <ThemeProvider attribute="class" defaultTheme="light">
      <DataAccessProvider impl={s}>
        <SessionProvider impl={new GatewaySession(silentPort)} seed={SIGNED_IN}>
          <UserMenu />
        </SessionProvider>
      </DataAccessProvider>
    </ThemeProvider>,
  );
  return s;
}

/**
 * Open a Radix DropdownMenu in jsdom: the trigger listens for POINTERDOWN, which jsdom cannot
 * synthesize meaningfully — Enter is the path Radix guarantees regardless, and it is also a real
 * accessibility claim (the window opens without a mouse).
 */
function open() {
  fireEvent.keyDown(screen.getByTestId('user-menu-trigger'), { key: 'Enter' });
}

describe('*** ⭐ the window exists, in the rail, on every screen ***', () => {
  it('the trigger sits in the rail’s footer — not in the top bar, where he weighed it and said no', () => {
    const s = stub();
    render(
      <ThemeProvider attribute="class" defaultTheme="light">
        <DataAccessProvider impl={s}>
          <SessionProvider impl={new GatewaySession(silentPort)} seed={SIGNED_IN}>
            <ContextPanelProvider>
              <AppShell>page</AppShell>
            </ContextPanelProvider>
          </SessionProvider>
        </DataAccessProvider>
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId('user-menu-trigger');
    // ⚠️ Inside the rail, which is what "on every screen and for every role" means structurally: the
    // shell renders it, so no page can forget to.
    expect(trigger.closest('[data-testid="sidebar"]')).not.toBeNull();
  });

  it('shows my name, and my state is readable WITHOUT opening anything', async () => {
    renderMenu({ presence: 'away' });

    const dot = await screen.findByTestId('presence-dot');
    // The point of putting the badge on the avatar: the answer to "am I taking work?" costs no click.
    expect(dot).toHaveAttribute('data-state', 'away');
    expect(screen.getByTestId('user-menu-trigger')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Away'),
    );
  });

  /**
   * ⚠️⚠️ **The menu names the four STATES, and must not name them with a word an administrator owns.**
   *
   * `Break` · `Lunch` · `Meeting` · `VIP task` are rows in a table (ADR 0042 §7), and
   * `tests/contracts/presence-label-never-branched-on.spec.ts` fails the build when a screen turns one
   * into a constant: *"The seed may name them; the product may not."* This file's first version wrote
   * `'Break'` and that test caught it.
   *
   * ⓘ Offering those admin PRESETS as extra choices is a separate feature (noted on W22): several map
   * to one state — on the stand `Break` and `Lunch` are both `away` — so using one as the state's name
   * would drop the other and rename a routing behaviour after a reason.
   */
  it('⛔ the menu never names a state with an administrator-owned word', async () => {
    renderMenu({ presence: 'away' });
    await screen.findByTestId('presence-dot');
    open();

    await screen.findByTestId('user-menu');
    /**
     * ⚠️ Asserted POSITIVELY — each item says exactly the state's own built-in word — and that shape is
     * not a stylistic choice. Listing the forbidden words here to check their absence is itself what
     * the guard forbids: it scans `.test.tsx`, and the first version of this very test failed on
     * naming them. So the check has to be "the text is the state's word", which is the stronger claim
     * anyway: any word from anywhere else, admin-owned or invented, fails it.
     */
    for (const c of PRESENCE_CHOICES) {
      expect(screen.getByTestId(`presence-${c.state}`)).toHaveTextContent(c.label);
    }
  });

  it('renders even when /me/operator fails — chrome must not disappear because a read did', async () => {
    renderMenu({ failOperator: true });
    expect(await screen.findByTestId('user-menu-trigger')).toBeInTheDocument();
  });
});

describe('*** ⭐⭐ the statuses — all four the server accepts, and the write is real ***', () => {
  it('offers exactly the four states from @/data/presence, by their labels', async () => {
    renderMenu();
    await screen.findByTestId('presence-dot');
    open();

    const menu = await screen.findByTestId('user-menu');
    for (const choice of PRESENCE_CHOICES) {
      expect(screen.getByTestId(`presence-${choice.state}`)).toHaveTextContent(choice.label);
    }
    // Exactly four: a fifth entry would mean a state the server refuses, and the two-state settings
    // page is what this replaced.
    expect(menu.querySelectorAll('[data-testid^="presence-"]')).toHaveLength(
      PRESENCE_CHOICES.length,
    );
  });

  it('choosing one PLACES it on the server — PUT /presence/me with that state', async () => {
    const s = renderMenu({ presence: 'online' });
    await screen.findByTestId('presence-dot');
    open();

    fireEvent.click(await screen.findByTestId('presence-away'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toEqual({ resource: 'my-presence', payload: { state: 'away' } });
    // The badge follows at once — the optimistic half, which is what makes the control feel answered.
    await waitFor(() =>
      expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-state', 'away'),
    );
  });

  it('⚠️ a REFUSED write puts the previous state back — the badge never lies about routing', async () => {
    const s = renderMenu({ presence: 'online', failPresenceWith: { message: 'no', retryable: true } });
    await screen.findByTestId('presence-dot');
    open();

    fireEvent.click(await screen.findByTestId('presence-away'));
    await waitFor(() => expect(s.writes).toHaveLength(1));

    /**
     * The whole reason the optimistic write is BOUNDED. A control that kept its new value after a
     * refusal would tell somebody they are on a break while the router keeps sending them tickets —
     * the worst available outcome for this particular field, and invisible from the screen.
     */
    await waitFor(() =>
      expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-state', 'online'),
    );
  });
});

describe('*** ⭐ the presets — the administrator’s words BELOW the states, never AS them (W22-доп) ***', () => {
  /**
   * ⚠️ The fixture deliberately carries TWO presets pointing at ONE state. That cardinality is what
   * live data taught on 2026-08-10: a `PresenceLabel` is a preset with a reason, several per state,
   * and the first build — which used one as the state's NAME — dropped one of each pair and renamed
   * a routing behaviour after a reason. It was reverted the same day; this section is the correct
   * shape. (The names here are invented on purpose: the seeded words are admin-owned rows, and the
   * label guard scans this file too.)
   */
  const PRESETS = [
    { id: 'p1', name: 'Coffee', state: 'away' },
    { id: 'p2', name: 'Deep work', state: 'away' },
    { id: 'p3', name: 'Handover', state: 'transfers_only' },
  ];

  it('⭐ EVERY preset renders — both of a same-state pair — and below the four states', async () => {
    renderMenu({ presets: PRESETS });
    await screen.findByTestId('presence-dot');
    open();

    await screen.findByTestId('user-menu');
    // Cardinality is the claim: two presets sharing `away` are two rows, not a first-one-wins pick.
    for (const p of PRESETS) {
      expect(await screen.findByTestId(`status-preset-${p.id}`)).toHaveTextContent(p.name);
    }
    // …and the section sits BELOW the states — the operator's words: «ниже четырёх базовых».
    const lastState = screen.getByTestId('presence-offline');
    const firstPreset = screen.getByTestId('status-preset-p1');
    expect(
      lastState.compareDocumentPosition(firstPreset) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('choosing one writes the PAIR — its state AND its labelId — and the badge follows', async () => {
    const s = renderMenu({ presence: 'online', presets: PRESETS });
    await screen.findByTestId('presence-dot');
    open();

    fireEvent.click(await screen.findByTestId('status-preset-p1'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    // The reason travels WITH the behaviour: the router reads the state, the label rides as the why.
    expect(s.writes[0]).toEqual({
      resource: 'my-presence',
      payload: { state: 'away', labelId: 'p1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-state', 'away'),
    );
  });

  it('a bare state afterwards clears the label — the payload carries NO labelId', async () => {
    const s = renderMenu({ presence: 'away', labelId: 'p1', presets: PRESETS });
    await screen.findByTestId('presence-dot');
    open();

    fireEvent.click(await screen.findByTestId('presence-online'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    // The gateway turns the absent key into `null`; the server persists a label-only change too.
    expect(s.writes[0]).toEqual({ resource: 'my-presence', payload: { state: 'online' } });
  });

  it('the server’s active preset carries the ✓ — and the state row yields it', async () => {
    renderMenu({ presence: 'away', labelId: 'p1', presets: PRESETS });
    await screen.findByTestId('presence-dot');
    open();

    await screen.findByTestId('user-menu');
    // Exactly ONE row is "current": the preset (the exact fact), not the state it maps to.
    expect(screen.getByTestId('status-preset-p1')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('status-preset-p2')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('presence-away')).not.toHaveAttribute('aria-current');
    // The header names the reason next to the behaviour — «Coffee — Nothing new is routed to you».
    expect(screen.getByTestId('user-menu')).toHaveTextContent('Coffee');
  });

  it('⚠️ a REFUSED preset write puts BOTH facts back — state and reason', async () => {
    const s = renderMenu({
      presence: 'online',
      presets: PRESETS,
      failPresenceWith: { message: 'no', retryable: true },
    });
    await screen.findByTestId('presence-dot');
    open();

    fireEvent.click(await screen.findByTestId('status-preset-p1'));
    await waitFor(() => expect(s.writes).toHaveLength(1));

    // The badge never lies about routing — and a stale ✓ would lie about the recorded reason.
    await waitFor(() =>
      expect(screen.getByTestId('presence-dot')).toHaveAttribute('data-state', 'online'),
    );
    open();
    expect(screen.getByTestId('status-preset-p1')).not.toHaveAttribute('aria-current');
  });

  it('⛔ no presets → no section, and a row this build cannot vouch for is not offered', async () => {
    renderMenu({
      presets: [
        // A state this client does not know: clicking it would set a behaviour we cannot even name.
        { id: 'px', name: 'Ghost', state: 'sparkling' },
        // A row without an id could never be written back correctly.
        { id: '', name: 'Nameless target', state: 'away' },
      ],
    });
    await screen.findByTestId('presence-dot');
    open();

    await screen.findByTestId('user-menu');
    // Both rows failed the fail-closed filter, so the whole section is absent — same as no presets.
    expect(screen.queryByTestId('preset-header')).toBeNull();
    expect(screen.queryByTestId('status-preset-px')).toBeNull();
  });
});

describe('*** ⛔ what is deliberately NOT in this window ***', () => {
  /**
   * Both were moved to account settings on the operator's instruction — sign-out because *«это
   * как-то слишком легко»*, the theme because the chrome is not where it belongs (R40). Asserted as
   * absences because a duplicate left behind here would look exactly like a working product.
   *
   * ⚠️ Sign-out's real guarantee — it ends the session ON THE SERVER, not by flipping a local flag —
   * travelled WITH it and is asserted in `settings.test.tsx`. A check that stays behind when its
   * subject moves is how a guarantee evaporates while every file still looks right.
   */
  it('no sign-out and no theme switch live here', async () => {
    renderMenu();
    await screen.findByTestId('presence-dot');
    open();

    await screen.findByTestId('user-menu');
    expect(screen.queryByRole('menuitem', { name: /log ?out|sign ?out|выйти/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /theme|dark|light/i })).toBeNull();
  });

  it('…but the way INTO account settings is here — that is the other half he asked for', async () => {
    renderMenu();
    await screen.findByTestId('presence-dot');
    open();

    const link = await screen.findByTestId('user-menu-settings');
    expect(link).toHaveAttribute('href', '/settings');
  });
});
