import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './page';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort, HttpRequest, HttpResponse } from '@/data/gateway/http-port';

/**
 * T021/T022/T025/T028 [027] — the sign-in page as a two-step machine over the real session boundary.
 *
 * ── Driven through a real `GatewaySession` over a scripted port, not a stubbed session ──────────
 * A session double would let this suite assert that the page reacts to outcomes somebody typed. The
 * outcomes here are produced by the same mapping the product uses, so a mistake in that mapping —
 * the `unreachable`-versus-`rejected` one especially — fails here too.
 *
 * Ferrofluid is a WebGL background; jsdom has no WebGL. Mocked by relative path because `jest.mock`
 * with the `@/` alias trips over the `(auth)` route-group parentheses.
 */
jest.mock('../../../src/components/Ferrofluid', () => ({ __esModule: true, default: () => null }));

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

const NOW_SECONDS = 1_800_000_000;
const CODE_SENT: HttpResponse = {
  status: 200,
  body: { status: 'code_sent', challengeId: 'ch-1', codeExpiresAt: NOW_SECONDS + 300 },
};
const OK: HttpResponse = { status: 200, body: { status: 'ok' } };
const REJECTED: HttpResponse = { status: 401, body: { status: 'invalid_credentials' } };
const LOCKED: HttpResponse = { status: 423, body: { status: 'locked' } };
const BAD_CODE: HttpResponse = { status: 401, body: { status: 'invalid_code' } };
const DEAD: HttpResponse = { status: 0, body: undefined };
const IDENTITY: HttpResponse = {
  status: 200,
  body: { userId: 'u1', accountId: 'a1', roles: ['agent'] },
};

let sent: HttpRequest[] = [];

function renderLogin(script: HttpResponse[]) {
  sent = [];
  let i = 0;
  const port: HttpPort = async (req) => {
    sent.push(req);
    const res = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return res;
  };
  return render(
    <SessionProvider impl={new GatewaySession(port)} seed={{ kind: 'anonymous' }}>
      <LoginPage />
    </SessionProvider>,
  );
}

async function submitCredentials(email = 'agent@example.test', password = 'pw') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
  mockReplace.mockClear();
  mockPush.mockClear();
});

afterEach(() => jest.restoreAllMocks());

describe('sign-in — step 1, the credentials', () => {
  it('moves to the code step and says a code was sent', async () => {
    renderLogin([CODE_SENT]);
    await submitCredentials();

    expect(await screen.findByLabelText(/code/i)).toBeInTheDocument();
    expect(screen.getByText(/we sent a code/i)).toBeInTheDocument();
    // The password field is gone: step 2 is about the code, and leaving a password on screen
    // invites a second submission of it.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('sends the credentials in a body, never in a URL', async () => {
    renderLogin([CODE_SENT]);
    await submitCredentials('agent@example.test', 'hunter2');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.query).toBeUndefined();
    expect(JSON.stringify(sent[0]!.body)).toContain('hunter2');
  });

  it('blocks an invalid email locally and sends nothing', async () => {
    renderLogin([CODE_SENT]);
    await submitCredentials('not-an-email');

    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('⚠️ a rejection never reveals whether the address exists (FR-011)', async () => {
    renderLogin([REJECTED]);
    await submitCredentials();

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/not accepted/i);
    expect(message.textContent).not.toMatch(/exist|unknown|not found|no account|register/i);
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
  });

  it('a locked account says so — distinctly from a rejection (FR-013)', async () => {
    renderLogin([LOCKED]);
    await submitCredentials();

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/locked/i);
    expect(message.textContent).not.toMatch(/not accepted/i);
  });

  it('⭐ a dead gateway is a service message, NOT a credential failure (FR-014)', async () => {
    // The defect this prevents: a person retyping — and later resetting — a password that was
    // never the problem, while the real fault goes unreported.
    renderLogin([DEAD]);
    await submitCredentials();

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/could not reach|try again/i);
    expect(message.textContent).not.toMatch(/password|credential|not accepted|incorrect/i);
  });
});

describe('sign-in — step 2, the code', () => {
  async function reachCodeStep(afterCodeStep: HttpResponse[]) {
    renderLogin([CODE_SENT, ...afterCodeStep]);
    await submitCredentials();
    await screen.findByLabelText(/code/i);
  }

  it('signs in and lands inside, replacing history so Back cannot return here (FR-004)', async () => {
    await reachCodeStep([OK, IDENTITY]);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('sends remember-me to the SERVER, on the verify call (FR-003)', async () => {
    await reachCodeStep([OK, IDENTITY]);

    fireEvent.click(screen.getByLabelText(/remember me/i));
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    // The API takes `rememberMe` on verify, not on login — asserted on the wire, because "it is
    // applied where it is collected" is exactly the kind of thing that drifts.
    expect(sent[1]!.path).toBe('/auth/verify');
    expect(sent[1]!.body).toMatchObject({ rememberMe: true });
    expect(sent[0]!.body).not.toHaveProperty('rememberMe');
  });

  it('⭐ a wrong code says "not right" while the challenge is still fresh (FR-012)', async () => {
    await reachCodeStep([BAD_CODE]);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/not right/i);
    expect(message.textContent).not.toMatch(/expired/i);
  });

  it('⭐ the same server answer reads as EXPIRED once our own clock passes the expiry', async () => {
    // The server answers `invalid_code` for wrong, expired, consumed and exhausted alike — a
    // deliberate decision this feature does not ask it to change. The distinction is made here,
    // from `codeExpiresAt`, which step 1 already returned.
    await reachCodeStep([BAD_CODE]);

    jest.spyOn(Date, 'now').mockReturnValue((NOW_SECONDS + 301) * 1000);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/expired/i);
  });

  it('⚠️ the expiry is read as SECONDS — a millisecond reading would never expire', async () => {
    // `codeExpiresAt` is UNIX seconds (`otp.service.ts`). Treated as milliseconds it lands in 1970,
    // and every code reads as expired; compared against `Date.now()` unscaled, none ever does.
    await reachCodeStep([BAD_CODE]);

    // One second BEFORE the expiry: still fresh, so "not right" rather than "expired".
    jest.spyOn(Date, 'now').mockReturnValue((NOW_SECONDS + 299) * 1000);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/not right/i);
  });

  it('⭐ accepts a pasted code with a newline, and one typed in lower case', async () => {
    // The defect the first real sign-in hit: the code was correct and the paste carried a
    // trailing newline, so the server refused it and the screen said "that code is not right".
    await reachCodeStep([OK, IDENTITY]);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: ' rfdv8t\n' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    expect(sent[1]!.body).toMatchObject({ code: 'RFDV8T' });
  });

  it('⚠️ the code field does not ask for a numeric keyboard', async () => {
    // The code is upper-case LETTERS AND DIGITS. `inputMode="numeric"` shipped on 2026-08-02 and
    // left a phone unable to type it at all — invisible on a desktop, fatal on a phone.
    await reachCodeStep([OK]);
    expect(screen.getByLabelText(/code/i)).not.toHaveAttribute('inputmode', 'numeric');
  });

  it('a dead gateway during the code step is a service message', async () => {
    await reachCodeStep([DEAD]);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/could not reach|try again/i);
    expect(message.textContent).not.toMatch(/not right|expired/i);
  });

  it('going back to the credentials step discards the challenge', async () => {
    await reachCodeStep([OK]);

    fireEvent.click(screen.getByRole('button', { name: /use a different account/i }));

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
  });
});

describe('sign-in — what must never appear on screen (FR-015)', () => {
  it('no rendered text contains the submitted password or code', async () => {
    const { container } = renderLogin([CODE_SENT, BAD_CODE]);
    await submitCredentials('agent@example.test', 'Sup3rSecret!');
    await screen.findByLabelText(/code/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: '987654' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByRole('alert');

    // The code field's own value is excluded: a person must be able to see what they typed. What
    // must not happen is the value appearing in a MESSAGE, a heading or a hidden attribute.
    const rendered = container.innerHTML.replace(/value="987654"/g, '');
    expect(rendered).not.toContain('Sup3rSecret!');
    expect(rendered).not.toContain('987654');
  });
});
