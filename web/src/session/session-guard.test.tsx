import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SessionGuard } from './session-guard';
import { SessionProvider } from './session-provider';
import { GatewaySession } from './gateway-session';
import type { HttpPort, HttpResponse } from '../data/gateway/http-port';
import type { SessionState } from './session';

/**
 * T019 [027] — the guard over all four states.
 *
 * ⚠️ **`unreachable` is driven by a FAILING TRANSPORT, not by a stubbed session.** A stub always
 * answers, and the bug being guarded against is precisely a non-answer: a session double that
 * returns `{kind:'unreachable'}` on demand proves the guard's switch statement and nothing about
 * whether the state can ever be produced. So these tests build a real `GatewaySession` over a port
 * that fails, which is the only arrangement in which the defect could have been seen.
 */

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

beforeEach(() => mockReplace.mockClear());

/** A port whose answers are scripted; the last entry repeats. */
function portOf(script: HttpResponse[]): HttpPort {
  let i = 0;
  return async () => {
    const res = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return res;
  };
}

const IDENTITY: HttpResponse = {
  status: 200,
  body: { userId: 'u1', accountId: 'a1', roles: ['agent'] },
};
const NO_SESSION: HttpResponse = { status: 401, body: { message: 'Unauthorized', statusCode: 401 } };
const DEAD: HttpResponse = { status: 0, body: undefined };

function renderGuard(script: HttpResponse[], seed: SessionState = { kind: 'resolving' }) {
  return render(
    <SessionProvider impl={new GatewaySession(portOf(script))} seed={seed}>
      <SessionGuard>
        <div>secret content</div>
      </SessionGuard>
    </SessionProvider>,
  );
}

describe('SessionGuard — four states', () => {
  it('authenticated: renders the protected content and does not redirect', async () => {
    renderGuard([IDENTITY]);
    expect(await screen.findByText('secret content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('anonymous: redirects to /login and shows nothing protected', async () => {
    renderGuard([NO_SESSION]);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('resolving: holds — neither the content nor a redirect', async () => {
    // Asserted synchronously, before the port has answered: this is the frame in which a flash
    // would happen, and the only one in which it can be observed.
    renderGuard([IDENTITY]);
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();

    // Then let the resolution land, so the pending state update happens inside the test rather
    // than after it — an unsettled promise here reports as a React `act()` warning in the NEXT test.
    expect(await screen.findByText('secret content')).toBeInTheDocument();
  });

  it('⭐ unreachable: holds, says so, and does NOT redirect', async () => {
    renderGuard([DEAD]);

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    // The assertion that matters: a failure to ask never becomes a sign-out.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('⭐ recovers when the service comes back, without the person signing in again', async () => {
    // First call fails, the retry succeeds. If `unreachable` had been folded into `anonymous`, the
    // person would already be on the sign-in screen and this recovery could not exist.
    renderGuard([DEAD, IDENTITY]);

    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));

    expect(await screen.findByText('secret content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('a seeded anonymous never asks the gateway at all', async () => {
    // No cookie existed, so the server's answer is authoritative and the sign-in page can paint
    // immediately. The port here would answer with an identity — the point is that it is not asked.
    const asked: string[] = [];
    const port: HttpPort = async (req) => {
      asked.push(req.path);
      return IDENTITY;
    };
    render(
      <SessionProvider impl={new GatewaySession(port)} seed={{ kind: 'anonymous' }}>
        <SessionGuard>
          <div>secret content</div>
        </SessionGuard>
      </SessionProvider>,
    );

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(asked).toEqual([]);
  });
});
