import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { TicketWindow } from './ticket-window';
import { ContextPanelProvider } from '@/components/shell/context-panel';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, type TicketStub } from './test-support';

/**
 * W9 / spec 035 — the search-and-attach flow (ADR 0044 §4/§5).
 *
 * ⚠️⚠️ Read every title here as "…is not RENDERED", never "…is not permitted". The refusal lives
 * in THREE server tiers (gateway route key, chats context check, users key + audit + cap) and is
 * asserted there and in the live round. A hidden box proves nothing about a crafted request — the
 * pedantry is borrowed verbatim from `bulk-actions.test.tsx`, for the same reason.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

function renderWindow(stub: TicketStub, permissionKeys: string[]) {
  setDataAccess(stub);
  const seed: SessionState = {
    kind: 'authenticated',
    userId: 'u1',
    accountId: 'a1',
    roles: [],
    permissionKeys,
  };
  return render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <ContextPanelProvider><TicketWindow id="c1" /></ContextPanelProvider>
      </SessionProvider>
    </Providers>,
  );
}

const WITH_KEY = ['crm.inbox.view', 'crm.contact.lookup'];
const WITHOUT_KEY = ['crm.inbox.view', 'crm.contact.view'];
const UNIDENTIFIED = { detail: { identityState: 'unidentified', playerId: '' } };

/**
 * ⭐ 2026-08-10 — the box is FOLDED behind one link, so every search test opens it first.
 *
 * The operator asked why a contact search sits on a ticket at all («не вижу в этом смысла»). It is
 * the only route to attaching a customer (ADR 0044 §4), so what went is the clutter, not the
 * capability — and these tests are what say that out loud: the flow below is unchanged, one click
 * deeper.
 */
function openLookup() {
  fireEvent.click(screen.getByTestId('lookup-open'));
}

describe('the lookup box appears only where 0044 allows it', () => {
  it('⛔ NOT RENDERED without the key — even on an unidentified ticket', async () => {
    renderWindow(stubTicket(UNIDENTIFIED), WITHOUT_KEY);
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('lookup-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lookup-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-panel')).not.toBeInTheDocument();
  });

  it('⛔ NOT RENDERED on an IDENTIFIED ticket — the search is for tickets with no player', async () => {
    renderWindow(stubTicket(), WITH_KEY); // the default detail is identified
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('lookup-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lookup-value')).not.toBeInTheDocument();
    // What IS offered there is the reverse operation.
    expect(screen.getByTestId('detach-start')).toBeInTheDocument();
  });

  it('⭐ a key holder on an unidentified ticket gets a LINK, not a search box sitting open', async () => {
    renderWindow(stubTicket(UNIDENTIFIED), WITH_KEY);
    await screen.findByTestId('ticket-subject');
    expect(screen.getByTestId('lookup-open')).toBeInTheDocument();
    // The complaint, pinned: nothing that looks like a search until somebody asks for one.
    expect(screen.queryByTestId('lookup-value')).not.toBeInTheDocument();

    openLookup();
    expect(screen.getByTestId('lookup-value')).toBeInTheDocument();
  });

  it('cancel folds it away again and clears what was typed', async () => {
    renderWindow(stubTicket(UNIDENTIFIED), WITH_KEY);
    await screen.findByTestId('ticket-subject');
    openLookup();
    fireEvent.change(screen.getByTestId('lookup-value'), { target: { value: 'x@y.test' } });
    fireEvent.click(screen.getByTestId('lookup-close'));

    expect(screen.queryByTestId('lookup-value')).not.toBeInTheDocument();
    openLookup();
    expect(screen.getByTestId('lookup-value')).toHaveValue('');
  });
});

describe('the search composes exactly one request, under the conversation', () => {
  it('POSTs kind+value to the conversation’s own lookup child — never a global route', async () => {
    const stub = stubTicket(UNIDENTIFIED);
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');

    openLookup();
    fireEvent.click(screen.getByTestId('lookup-kind-phone'));
    fireEvent.change(screen.getByTestId('lookup-value'), { target: { value: '+380501234567' } });
    fireEvent.click(screen.getByTestId('lookup-search'));

    await waitFor(() => expect(stub.writes).toHaveLength(1));
    expect(stub.writes[0]).toMatchObject({
      resource: 'conversation-contact-lookup',
      within: 'c1',
      payload: { kind: 'phone', value: '+380501234567' },
    });
  });

  it('a match offers ATTACH and nothing else — no card, no contact echoed back', async () => {
    const stub = stubTicket(UNIDENTIFIED);
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');
    openLookup();
    fireEvent.change(screen.getByTestId('lookup-value'), { target: { value: 'x@y.test' } });
    fireEvent.click(screen.getByTestId('lookup-search'));

    const result = await screen.findByTestId('lookup-result');
    expect(result).toHaveTextContent('p-found');
    // ⛔ The searched value is not rendered back — it exists only in the request that carried it.
    expect(result).not.toHaveTextContent('x@y.test');

    fireEvent.click(screen.getByTestId('lookup-attach'));
    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({
        resource: 'conversation-player',
        op: 'update',
        within: 'c1',
        payload: { playerId: 'p-found' },
      }),
    );
  });

  it('⭐ AMBIGUOUS names nobody and offers no attach — the screen refuses to choose', async () => {
    const stub = stubTicket({
      ...UNIDENTIFIED,
      lookupAnswer: { matched: false, ambiguous: true, playerId: '', brandId: 'brand-a' },
    });
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');
    openLookup();
    fireEvent.change(screen.getByTestId('lookup-value'), { target: { value: 'x@y.test' } });
    fireEvent.click(screen.getByTestId('lookup-search'));

    const result = await screen.findByTestId('lookup-result');
    expect(result).toHaveTextContent('More than one record');
    expect(screen.queryByTestId('lookup-attach')).not.toBeInTheDocument();
  });

  it('a refusal (no key on the wire, or the rate cap) names itself and attaches nothing', async () => {
    const stub = stubTicket({
      ...UNIDENTIFIED,
      failLookupWith: { message: 'Too many lookups — try later.', retryable: false },
    });
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');
    openLookup();
    fireEvent.change(screen.getByTestId('lookup-value'), { target: { value: 'x@y.test' } });
    fireEvent.click(screen.getByTestId('lookup-search'));

    expect(await screen.findByTestId('identity-error')).toHaveTextContent('Too many lookups');
    expect(stub.writes.filter((w) => w.resource === 'conversation-player')).toHaveLength(0);
  });
});

describe('⭐ detach WARNS FIRST (0044 §5: nothing written is taken back)', () => {
  it('shows what stays on the player’s record BEFORE the detach, and only then detaches', async () => {
    const stub = stubTicket();
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('detach-start'));
    // The preview READ happens first — the dialog is not guesswork.
    expect(await screen.findByTestId('detach-counts')).toHaveTextContent('2 replies, 1 notes');
    expect(stub.writes.filter((w) => w.op === 'remove')).toHaveLength(0); // nothing detached yet

    fireEvent.click(screen.getByTestId('detach-confirm-button'));
    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({ op: 'remove', resource: 'conversation-player', within: 'c1' }),
    );
  });

  it('cancel leaves the player attached and writes nothing', async () => {
    const stub = stubTicket();
    renderWindow(stub, WITH_KEY);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('detach-start'));
    await screen.findByTestId('detach-confirm');
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByTestId('detach-confirm')).not.toBeInTheDocument();
    expect(stub.writes.filter((w) => w.op === 'remove')).toHaveLength(0);
  });
});
