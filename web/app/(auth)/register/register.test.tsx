import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RegisterPage from './page';
import { SessionProvider, GatewaySession } from '@/session';
import type { HttpPort, HttpRequest, HttpResponse } from '@/data/gateway/http-port';

/**
 * T029/T032 [027] — accepting an invitation.
 *
 * On a fresh deployment **every** account arrives this way, which is why this is not a P2 story:
 * without it, the only people who can sign in are the ones the seed created.
 */
jest.mock('../../../src/components/Ferrofluid', () => ({ __esModule: true, default: () => null }));

const mockReplace = jest.fn();
let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => searchParams,
}));

const CODE_SENT: HttpResponse = {
  status: 200,
  body: { status: 'code_sent', codeExpiresAt: 1_800_000_300 },
};
const OK: HttpResponse = { status: 200, body: { status: 'ok' } };
const INVALID: HttpResponse = { status: 401, body: { status: 'invalid' } };
const WEAK: HttpResponse = { status: 422, body: { status: 'weak_password' } };
const DEAD: HttpResponse = { status: 0, body: undefined };
const IDENTITY: HttpResponse = {
  status: 200,
  body: { userId: 'u9', accountId: 'a1', roles: ['agent'] },
};

let sent: HttpRequest[] = [];

function renderRegister(script: HttpResponse[], token: string | null = 'inv-1.secret') {
  sent = [];
  searchParams = new URLSearchParams(token === null ? '' : `token=${token}`);
  let i = 0;
  const port: HttpPort = async (req) => {
    sent.push(req);
    const res = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return res;
  };
  return render(
    <SessionProvider impl={new GatewaySession(port)} seed={{ kind: 'anonymous' }}>
      <RegisterPage />
    </SessionProvider>,
  );
}

async function confirmAddress(email = 'invited@example.test') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

beforeEach(() => mockReplace.mockClear());

describe('invite acceptance — without a token there is nothing here (FR-006)', () => {
  it('offers no field and sends no request', () => {
    renderRegister([CODE_SENT], null);

    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('says what is needed, without implying an account can be created here', () => {
    renderRegister([CODE_SENT], null);

    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/invitation/i);
    // There is no self-registration in this product and this page must not suggest otherwise.
    expect(text).not.toMatch(/sign up|create an account|register now/i);
  });
});

describe('invite acceptance — step 1, confirming the address', () => {
  it('⚠️ does NOT pre-fill the address from the token', () => {
    // The server's check that the typed address matches the invited one is the safeguard. Filling
    // it in for them makes that check theatre: everyone would "match" by construction.
    renderRegister([CODE_SENT]);
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('sends the token in the body and moves to the code step', async () => {
    renderRegister([CODE_SENT]);
    await confirmAddress();

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.path).toBe('/auth/register/start');
    expect(sent[0]!.body).toEqual({ token: 'inv-1.secret', email: 'invited@example.test' });
    expect(sent[0]!.query).toBeUndefined(); // the token must never reach a URL (FR-015)
    expect(await screen.findByLabelText(/code/i)).toBeInTheDocument();
  });

  it('a refusal does not separate a bad token from a wrong address', async () => {
    // Separating them would confirm which addresses were invited.
    renderRegister([INVALID]);
    await confirmAddress('someone-else@example.test');

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/not accepted|could not be used/i);
    expect(message.textContent).not.toMatch(/token|address does not match|not invited/i);
  });

  it('a dead gateway is a service message, not a refusal', async () => {
    renderRegister([DEAD]);
    await confirmAddress();

    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(/could not reach|try again/i);
    expect(message.textContent).not.toMatch(/not accepted/i);
  });
});

describe('invite acceptance — step 2, the code and the password together', () => {
  async function reachSecondStep(after: HttpResponse[]) {
    renderRegister([CODE_SENT, ...after]);
    await confirmAddress();
    await screen.findByLabelText(/code/i);
  }

  function fillAndSubmit(password: string, code = '123456') {
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: code } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: /finish/i }));
  }

  it('states the password policy BEFORE the field (FR-008)', async () => {
    await reachSecondStep([OK]);

    const policy = screen.getByTestId('password-policy');
    expect(policy.textContent).toMatch(/6 characters/i);
    expect(policy.textContent).toMatch(/uppercase/i);
    expect(policy.textContent).toMatch(/digit/i);
    expect(policy.textContent).toMatch(/symbol/i);

    // "Before" is positional, and it is the whole requirement: a rule shown after a rejection is a
    // guessing game the person has already lost once.
    const field = screen.getByLabelText(/password/i);
    expect(policy.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⭐ submits the code and the password TOGETHER — the API’s order, not the prose’s', async () => {
    await reachSecondStep([OK, IDENTITY]);
    fillAndSubmit('Passw0rd!');

    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    expect(sent[1]!.path).toBe('/auth/register/complete');
    expect(sent[1]!.body).toEqual({
      token: 'inv-1.secret',
      email: 'invited@example.test',
      code: '123456',
      password: 'Passw0rd!',
    });
  });

  it('signs the new person in and lands them inside', async () => {
    await reachSecondStep([OK, IDENTITY]);
    fillAndSubmit('Passw0rd!');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  });

  it('⭐ a weak password KEEPS the rest of the form', async () => {
    // Losing the code on a password rejection would send the person back for a new one, which is a
    // second email and a second chance for the challenge to expire.
    //
    // ⚠️ The password here PASSES the client mirror and is refused by the server anyway — which is
    // the deployment-configured-something-stricter case, and the only one in which a 422 can reach
    // this screen at all.
    await reachSecondStep([WEAK]);
    fillAndSubmit('Passw0rd!');

    expect((await screen.findByRole('alert')).textContent).toMatch(/policy|requirements/i);
    expect(screen.getByLabelText(/code/i)).toHaveValue('123456');
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('⚠️ the message does not claim WHICH rule failed — the gateway does not say', async () => {
    // `registration.controller.ts` answers `{status:'weak_password'}` and nothing else: the
    // `failures` list exists inside Auth and is discarded at the edge. Naming a rule here would be
    // an invention, and the person would go and fix the wrong thing.
    await reachSecondStep([WEAK]);
    fillAndSubmit('Passw0rd!');

    const message = (await screen.findByRole('alert')).textContent ?? '';
    expect(message).not.toMatch(/missing an uppercase|needs a digit|add a symbol|too short/i);
  });

  it('the client refuses an obviously non-compliant password before sending it', async () => {
    // A mirror of the server's default policy, not a replacement for it: it saves a round trip,
    // and the server still decides. If the deployment's policy is stricter, the server refuses and
    // the message says the policy was not met — which is why that message names no rule.
    await reachSecondStep([OK]);
    fillAndSubmit('nope');

    expect(await screen.findByText(/at least 6 characters/i)).toBeInTheDocument();
    expect(sent).toHaveLength(1); // step 1 only — nothing was sent for step 2
  });
});
