import { render, screen } from '@testing-library/react';
import LoginPage from './page';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort } from '@/data/gateway/http-port';

/**
 * T037 [027] — ⭐ **THE SIGN-IN SCREEN'S VISUAL LAYER IS FROZEN BY OPERATOR INSTRUCTION** (FR-023).
 *
 * > *«У нас там в прототипе было окно регистрации с красивым эффектом, я надеюсь ты его менять не
 * > будешь.»*
 *
 * A comment saying so does not survive the next tidy-up, and the person doing the tidying has no
 * way to know the page was special. So it is a test — and FR-024 requires exactly that rather than
 * a comment.
 *
 * ── Why it asserts the RENDERED output and not the source text ──────────────────────────────────
 * Grepping the file would break on reformatting and would pass on the change that actually matters:
 * a prop quietly becoming a different number. `glow={2}` → `glow={0.5}` is the erosion being
 * guarded against, and a presence-only check sails straight through it.
 *
 * ── ⚠️ Pinned NARROWLY, on purpose ──────────────────────────────────────────────────────────────
 * The effect and the neutral mark, not the page's whole markup. A snapshot of the entire page would
 * fail on every legitimate change to the form — the step and error states this very feature adds —
 * and a test that fails for legitimate reasons gets deleted, taking the operator's guarantee with
 * it. If THIS test fails, the fix is the code.
 *
 * ⓘ **The spec says "thirteen prop values"; the page passes fourteen.** The one the count misses is
 * `mouseInteraction`, which is written as a valueless shorthand and so does not look like a value.
 * All fourteen are pinned here, because a guarantee that skips the one that is easy to overlook is
 * exactly the wrong one to skip.
 */

// The mock renders the props it was given, so the assertions below are about the rendered output.
jest.mock('../../../src/components/Ferrofluid', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => (
    <div data-testid="ferrofluid" data-props={JSON.stringify(props)} />
  ),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

/** Every value the operator's instruction covers. Changing one here changes the product. */
const FROZEN_PROPS = {
  colors: ['#ffffff', '#ffffff', '#ffffff'],
  speed: 0.5,
  scale: 1.6,
  turbulence: 1,
  fluidity: 0.1,
  rimWidth: 0.2,
  sharpness: 2.5,
  shimmer: 1.5,
  glow: 2,
  flowDirection: 'down',
  opacity: 1,
  mouseInteraction: true,
  mouseStrength: 1,
  mouseRadius: 0.35,
} as const;

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

function renderLogin() {
  return render(
    <SessionProvider impl={new GatewaySession(silentPort)} seed={{ kind: 'anonymous' }}>
      <LoginPage />
    </SessionProvider>,
  );
}

describe('the sign-in screen’s frozen visual (FR-023/024)', () => {
  it('renders the Ferrofluid background with every prop value unchanged', () => {
    renderLogin();
    const props = JSON.parse(screen.getByTestId('ferrofluid').dataset.props ?? '{}');

    expect(props).toMatchObject(FROZEN_PROPS);
  });

  it('passes no prop the operator did not see', () => {
    // A new prop is a visual change too, and it would slip past a subset match.
    renderLogin();
    const props = JSON.parse(screen.getByTestId('ferrofluid').dataset.props ?? '{}');

    expect(Object.keys(props).sort()).toEqual(Object.keys(FROZEN_PROPS).sort());
  });

  it('keeps the dark backdrop the white fluid needs to be visible', () => {
    const { container } = renderLogin();
    const backdrop = container.querySelector('.dark.fixed.inset-0');

    expect(backdrop).not.toBeNull();
    expect(backdrop?.className).toContain('bg-background');
    expect(backdrop?.querySelector('[data-testid="ferrofluid"]')).not.toBeNull();
  });

  it('keeps the radial-masked blur layer around the card', () => {
    const { container } = renderLogin();
    const blur = container.querySelector('[class*="backdrop-blur-"]');

    expect(blur).not.toBeNull();
    expect(blur?.className).toContain('backdrop-blur-[8px]');
    // The mask is what makes it fade out instead of being a visible disc.
    expect((blur as HTMLElement).style.maskImage).toContain('radial-gradient(closest-side');
  });

  it('keeps the card’s entrance animation', () => {
    const { container } = renderLogin();
    const card = container.querySelector('[class*="animate-in"]');

    expect(card).not.toBeNull();
    for (const cls of ['fade-in-50', 'zoom-in-95', 'duration-300', 'max-w-sm', 'shadow-lg']) {
      expect(card?.className).toContain(cls);
    }
  });

  it('keeps the wordmark NEUTRAL — no brand name, logo or colour (FR-025, Principle VI)', () => {
    const { container } = renderLogin();

    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByText('C').className).toContain('bg-primary');
    // White-label: a hex colour anywhere but the (deliberately white) fluid would be a committed
    // brand. The Ferrofluid props are excluded because their whiteness is the effect itself.
    const markup = container.innerHTML.replace(/data-props="[^"]*"/g, '');
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('advertises no demo path (T040)', () => {
    // The old copy said "any credentials work". It was true, and it is now false — which makes it
    // the most misleading sentence that could remain on the page.
    const { container } = renderLogin();
    expect(container.textContent).not.toMatch(/demo|any credentials/i);
  });
});
