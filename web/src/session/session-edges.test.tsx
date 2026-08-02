import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SessionProvider } from './session-provider';
import { SessionGuard } from './session-guard';
import { GatewaySession } from './gateway-session';
import { useSession } from './use-session';
import { withRefreshRotation } from '../data/gateway/rotating-port';
import type { HttpPort, HttpRequest } from '../data/gateway/http-port';

/**
 * T034/T035/T036 [027] — the session's edges: the parts that are about time and about other tabs,
 * rather than about a form.
 *
 * ⚠️ Every test here is built on a **fake server whose answers change**, not on a stubbed session.
 * A stub cannot express "this used to work and now does not", which is the entire subject.
 */

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

beforeEach(() => mockReplace.mockClear());

/**
 * A single fake gateway that several "tabs" share, holding its own session state — the closest a
 * jsdom test gets to the thing the real bug lives in.
 */
function fakeGateway() {
  const calls: HttpRequest[] = [];
  let signedIn = true;
  let accessValid = true;
  return {
    calls,
    endSession: () => {
      signedIn = false;
    },
    expireAccess: () => {
      accessValid = false;
    },
    port: (async (req) => {
      calls.push(req);
      if (req.path === '/auth/logout') {
        signedIn = false;
        return { status: 200, body: { status: 'logged_out' } };
      }
      if (req.path === '/auth/refresh') {
        if (!signedIn) return { status: 401, body: { status: 'unauthorized' } };
        accessValid = true; // the rotation is what makes the access token usable again
        return { status: 200, body: { status: 'ok' } };
      }
      if (!signedIn || !accessValid) {
        return { status: 401, body: { message: 'Unauthorized', statusCode: 401 } };
      }
      return { status: 200, body: { userId: 'u1', accountId: 'a1', roles: ['agent'] } };
    }) as HttpPort,
  };
}

/** A protected page that can be made to re-ask the way a navigation does. */
function ProtectedPage() {
  const { refresh } = useSession();
  return (
    <div>
      <span>protected page</span>
      <button type="button" onClick={() => void refresh()}>
        navigate
      </button>
    </div>
  );
}

function renderTab(port: HttpPort, label: string) {
  return render(
    <SessionProvider impl={new GatewaySession(port)} seed={{ kind: 'resolving' }}>
      <SessionGuard>
        <div>{label}</div>
      </SessionGuard>
    </SessionProvider>,
  );
}

describe('remember me is the SERVER’s decision (T034, FR-003)', () => {
  it('is forwarded on the verify call and changes nothing in the browser', async () => {
    const sent: HttpRequest[] = [];
    const port: HttpPort = async (req) => {
      sent.push(req);
      return { status: 200, body: { status: 'ok' } };
    };
    await new GatewaySession(port).submitCode('ch-1', '123456', true);

    expect(sent[0]!.body).toMatchObject({ rememberMe: true });
    // ⚠️ Track A can only prove it is SENT. That it lengthens anything is B4.1 on the live stand:
    // a mocked transport returns success whether the flag is honoured, ignored, or dropped.
    expect(Object.keys(localStorage)).toEqual([]);
    expect(document.cookie).toBe('');
  });
});

describe('an ended session (T035)', () => {
  it('sends the person to sign-in rather than to a broken page', async () => {
    const gw = fakeGateway();
    render(
      <SessionProvider impl={new GatewaySession(gw.port)} seed={{ kind: 'resolving' }}>
        <SessionGuard>
          <ProtectedPage />
        </SessionGuard>
      </SessionProvider>,
    );

    // ⭐ Positive control FIRST: the page really does render while the session is alive. Without it,
    // "the protected content is gone" is satisfied by a component that never rendered at all.
    expect(await screen.findByText('protected page')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();

    // The session ends on the server — no local event, nothing the browser could have noticed.
    gw.endSession();
    fireEvent.click(screen.getByRole('button', { name: 'navigate' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    // …and the person is not left looking at a page whose data will all fail to load.
    expect(screen.queryByText('protected page')).not.toBeInTheDocument();
  });

  it('⭐ a sign-out in one tab is not ignored by another the next time it asks', async () => {
    const gw = fakeGateway();

    const tabA = renderTab(gw.port, 'tab A');
    expect(await screen.findByText('tab A')).toBeInTheDocument();
    tabA.unmount();

    // Tab B mounts AFTER the session ended elsewhere. It asks the server, as every mount does,
    // and gets the truth — there is no local flag to disagree with.
    gw.endSession();
    renderTab(gw.port, 'tab B');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('tab B')).not.toBeInTheDocument();
  });
});

describe('the four states, end to end through the guard (T036)', () => {
  it('⭐ an expired ACCESS token rotates and the page never notices', async () => {
    // The heart of SC-005. Without the rotation this resolves to `anonymous` and the person is
    // thrown out mid-session — the failure that is invisible until a real token ages out.
    const gw = fakeGateway();
    gw.expireAccess();
    renderTab(withRefreshRotation(gw.port), 'still here');

    expect(await screen.findByText('still here')).toBeInTheDocument();
    expect(gw.calls.map((c) => c.path)).toEqual(['/auth/me', '/auth/refresh', '/auth/me']);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('⭐ when the rotation is refused the session really is over', async () => {
    const gw = fakeGateway();
    gw.endSession();
    renderTab(withRefreshRotation(gw.port), 'should not render');

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('should not render')).not.toBeInTheDocument();
    // Exactly one rotation attempt — a second would be a loop against a rate-limited endpoint.
    expect(gw.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });

  it('⚠️ unreachable is driven by a FAILING TRANSPORT, and holds instead of signing out', async () => {
    const dead: HttpPort = async () => ({ status: 0, body: undefined });
    renderTab(dead, 'should not render');

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
