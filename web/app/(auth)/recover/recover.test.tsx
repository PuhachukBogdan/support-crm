import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecoverPage from './page';
import CompleteRecoveryPage from './complete/page';

/**
 * W36 / feature 041 (roadmap 8.11) — the two recovery screens.
 *
 * What only a rendered test can state: that the confirmation **never varies**, that a dead link ends in an
 * actionable sentence, that a policy failure is named in words, and that success does not pretend the
 * person is signed in.
 *
 * ⚠️ How they LOOK is judged in a real browser in both themes (`w36-browser-check.mjs`) — jsdom has no
 * layout. These are the claims a DOM can carry.
 */

// ⚠️ Mocked by RELATIVE path, not by the `@/` alias — `jest.mock` resolves before moduleNameMapper, the
// same reason `login.test.tsx` states one folder over. jsdom has no WebGL, and the backdrop is decorative.
jest.mock('../../../src/components/Ferrofluid', () => ({ __esModule: true, default: () => null }));

const search = { get: () => 'tok-1.secret' as string | null };
jest.mock('next/navigation', () => ({
  useSearchParams: () => search,
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * ⚠️ The pages talk to the SESSION BOUNDARY, never to `fetch` — `no-direct-network.test.ts` refused the
 * first draft of them, and it was right. So the double here is the boundary's two verbs, which also means
 * these tests describe what a SCREEN can observe: outcome kinds, never status codes.
 */
const stub = {
  requestRecovery: jest.fn(),
  completeRecovery: jest.fn(),
};
// ⚠️ RELATIVE path again: `jest.mock` resolves before moduleNameMapper, so the `@/` alias does not
// exist yet at hoist time — the same trap the Ferrofluid mock above documents.
jest.mock('../../../src/session', () => ({ useSession: () => ({ session: stub, state: { kind: 'anonymous' }, refresh: jest.fn() }) }));

beforeEach(() => {
  stub.requestRecovery.mockReset();
  stub.completeRecovery.mockReset();
});

describe('*** the request screen says ONE thing, whatever the truth is ***', () => {
  it('a submitted address produces the fixed sentence and never echoes the address', async () => {
    stub.requestRecovery.mockResolvedValue({ kind: 'accepted' });
    render(<RecoverPage />);
    fireEvent.change(screen.getByTestId('recovery-email'), {
      target: { value: 'ann@example.test' },
    });
    fireEvent.click(screen.getByTestId('recovery-submit'));

    const sent = await screen.findByTestId('recovery-sent');
    expect(sent).toHaveTextContent(/if that address belongs to an account/i);
    // ⚠️ The address is not repeated back: a page that says «we emailed ann@example.test» has confirmed
    // the account exists to whoever typed it.
    expect(sent.textContent).not.toContain('ann@example.test');
  });

  it('⭐ the sentence is IDENTICAL for an address that exists and one that does not', async () => {
    // The endpoint answers 202 either way, so the screen cannot tell — which is the property. Rendered
    // twice with the same server answer to pin that there is no second success state to drift into.
    const texts: string[] = [];
    for (const address of ['ann@example.test', 'nobody@example.test']) {
      stub.requestRecovery.mockResolvedValue({ kind: 'accepted' });
      const view = render(<RecoverPage />);
      fireEvent.change(screen.getByTestId('recovery-email'), { target: { value: address } });
      fireEvent.click(screen.getByTestId('recovery-submit'));
      texts.push((await screen.findByTestId('recovery-sent')).textContent ?? '');
      view.unmount();
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('a failed REQUEST talks about the request, never about the address', async () => {
    stub.requestRecovery.mockResolvedValue({ kind: 'unreachable' });
    render(<RecoverPage />);
    fireEvent.change(screen.getByTestId('recovery-email'), { target: { value: 'ann@example.test' } });
    fireEvent.click(screen.getByTestId('recovery-submit'));

    const failed = await screen.findByTestId('recovery-failed');
    expect(failed).toHaveTextContent(/could not be sent/i);
    // «that address is wrong» is the one thing this page must never imply.
    expect(failed.textContent).not.toMatch(/address|email|account/i);
  });
});

describe('*** the completion screen ***', () => {
  it('sets the password, states the session count, and does NOT claim a session', async () => {
    stub.completeRecovery.mockResolvedValue({ kind: 'ok', revokedCount: 2 });
    render(<CompleteRecoveryPage />);
    fireEvent.change(screen.getByTestId('recovery-password'), { target: { value: 'New#Passw0rd' } });
    fireEvent.click(screen.getByTestId('recovery-complete-submit'));

    const ok = await screen.findByTestId('recovery-complete-ok');
    expect(ok).toHaveTextContent(/your password is set/i);
    expect(ok).toHaveTextContent(/2 signed-in sessions ended/i);
    // ⛔ It sends them to sign in — it must not read as «you are in».
    expect(screen.getByTestId('recovery-to-login')).toHaveTextContent(/sign in/i);
  });

  it.each([['gone'], ['rejected'], ['not_eligible']])(
    'a dead link (%s) ends in the SAME actionable sentence',
    async (kind) => {
    stub.completeRecovery.mockResolvedValue({ kind });
    const view = render(<CompleteRecoveryPage />);
    fireEvent.change(screen.getByTestId('recovery-password'), { target: { value: 'New#Passw0rd' } });
    fireEvent.click(screen.getByTestId('recovery-complete-submit'));

    const dead = await screen.findByTestId('recovery-link-dead');
    expect(dead).toHaveTextContent(/ask for a new one/i);
    expect(screen.getByTestId('recovery-ask-again')).toBeInTheDocument();
    view.unmount();
  },
  );

  it('a policy failure names the RULES in words, not a generic «invalid»', async () => {
    stub.completeRecovery.mockResolvedValue({ kind: 'weak_password', failures: ['digit', 'symbol'] });
    render(<CompleteRecoveryPage />);
    fireEvent.change(screen.getByTestId('recovery-password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByTestId('recovery-complete-submit'));

    const weak = await screen.findByTestId('recovery-weak');
    expect(weak).toHaveTextContent(/a digit/i);
    expect(weak).toHaveTextContent(/a symbol/i);
    expect(weak.textContent).not.toMatch(/invalid/i);
  });

  it('a link with NO token shows the dead state without asking for a password', async () => {
    const original = search.get;
    search.get = () => null;
    render(<CompleteRecoveryPage />);
    await waitFor(() => expect(screen.getByTestId('recovery-link-dead')).toBeInTheDocument());
    expect(screen.queryByTestId('recovery-password')).not.toBeInTheDocument();
    search.get = original;
  });

  it('warns BEFORE saving that this signs them out everywhere', () => {
    stub.completeRecovery.mockResolvedValue({ kind: 'ok', revokedCount: 0 });
    render(<CompleteRecoveryPage />);
    // The consequence is on screen before the button is pressed, not discovered afterwards.
    expect(screen.getByText(/signs you out everywhere/i)).toBeInTheDocument();
  });
});
