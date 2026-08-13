import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { TicketWindow } from './ticket-window';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, makeMessage, type TicketStub } from './test-support';

/**
 * W7 — the block's jsdom minimum for the ticket window (subpoint 2.6). SHAPE claims only: what the
 * screen composes and renders. Whether the real gateway honours any of it is the browser check's
 * claim — including the freeze class, which no test here can see.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * Open a Radix DropdownMenu in jsdom: the trigger listens for POINTERDOWN, which jsdom cannot
 * synthesize meaningfully — the keyboard path (Enter) is the one Radix guarantees regardless of
 * pointer support, and it is also a real accessibility claim: the menu opens without a mouse.
 */
function openMenu(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

function renderWindow(stub: TicketStub, id = 'c1') {
  setDataAccess(stub);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <TicketWindow id={id} />
    </Providers>,
  );
}

describe('the window renders the record (happy path)', () => {
  it('shows the 4.18 subject, the status by AGENT name, and all four message kinds distinctly', async () => {
    const stub = stubTicket({
      messages: [
        makeMessage({ id: 'm1', kind: 'MESSAGE_KIND_INCOMING_CUSTOMER', body: 'my deposit is stuck' }),
        makeMessage({ id: 'm2', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'looking into it' }),
        makeMessage({ id: 'm3', kind: 'MESSAGE_KIND_PRIVATE_NOTE', body: 'PSP says declined' }),
        makeMessage({ id: 'm4', kind: 'MESSAGE_KIND_SYSTEM', body: 'Messaging session ended' }),
      ],
    });
    renderWindow(stub);

    expect(await screen.findByTestId('ticket-subject')).toHaveTextContent('Deposit stuck');
    // 'open' is the KEY; the header must render the catalogue's agent word for it.
    expect(screen.getByTestId('ticket-status')).toHaveTextContent('Open');

    const thread = screen.getByTestId('ticket-thread');
    expect(within(thread).getByText('my deposit is stuck').closest('[data-kind]')).toHaveAttribute('data-kind', 'customer');
    expect(within(thread).getByText('looking into it').closest('[data-kind]')).toHaveAttribute('data-kind', 'reply');
    const note = within(thread).getByText('PSP says declined').closest('[data-kind]');
    expect(note).toHaveAttribute('data-kind', 'note');
    // ⭐ The note is EXPLICITLY marked — a note mistaken for a reply is SEC-13's UI failure.
    expect(within(note as HTMLElement).getByTestId('note-chip')).toBeInTheDocument();
    expect(within(thread).getByText('Messaging session ended').closest('[data-kind]')).toHaveAttribute('data-kind', 'system');
  });

  it('an empty subject is a STATE («No subject yet»), never text invented from the thread', async () => {
    renderWindow(stubTicket({ detail: { subject: '', subjectSource: '' } }));
    expect(await screen.findByTestId('ticket-subject')).toHaveTextContent('No subject yet');
  });
});

describe('the composer composes the request (and only the request)', () => {
  it("sends kind:'note' VERBATIM, scoped to this conversation", async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('composer-mode-note'));
    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'internal only' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    await waitFor(() => expect(stub.writes).toHaveLength(1));
    expect(stub.writes[0]).toMatchObject({
      op: 'create',
      resource: 'conversation-messages',
      within: 'c1',
      payload: { kind: 'note', body: 'internal only' },
    });
    // The re-read renders the note — the message appears when the READ returns it, never merged.
    expect(await screen.findByText('internal only')).toBeInTheDocument();
  });

  it('⭐ «Submit as <status>» sends the message FIRST, then the status — one gesture, that order', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'fixed, closing' } });
    openMenu('composer-submit-as');
    fireEvent.click(await screen.findByText('Submit as Solved'));

    await waitFor(() => expect(stub.writes).toHaveLength(2));
    expect(stub.writes[0]).toMatchObject({ op: 'create', resource: 'conversation-messages' });
    expect(stub.writes[1]).toMatchObject({
      op: 'update',
      resource: 'conversation-status',
      within: 'c1',
      payload: { status: 'solved' },
    });
  });

  it('a failed send names itself and composes NOTHING further (the refusal)', async () => {
    const stub = stubTicket({ failSendWith: { message: 'The server refused this message.', retryable: false } });
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('refused');
    expect(stub.writes).toHaveLength(1); // the one attempt; no status write followed it
  });
});

describe('the left column writes what the operator does', () => {
  it('«take it» PUTs the caller’s OWN operator id — there is no field to name anyone else', async () => {
    const stub = stubTicket({ myOperatorId: 'op-me' });
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('take-it'));
    await waitFor(() => expect(stub.writes).toHaveLength(1));
    expect(stub.writes[0]).toMatchObject({
      op: 'update',
      resource: 'conversation-assignee',
      id: '',
      within: 'c1',
      payload: { operatorId: 'op-me' },
    });
  });

  it('«take it» is NOT RENDERED when the ticket is already mine, or while identity is unresolved', async () => {
    renderWindow(stubTicket({ myOperatorId: 'op-x', detail: { assigneeOperatorId: 'op-x' } }));
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('take-it')).not.toBeInTheDocument();
  });

  it('tags attach and detach by id under the conversation, from the account registry only', async () => {
    const stub = stubTicket({
      labels: [{ id: 'l1', name: 'vip' }],
      accountLabels: [
        { id: 'l1', name: 'vip' },
        { id: 'l2', name: 'deposits' },
      ],
    });
    renderWindow(stub);
    await screen.findByText('vip');

    // Attach offers only what is NOT already on the ticket.
    openMenu('tag-add');
    const item = await screen.findByText('deposits');
    expect(screen.queryAllByText('vip', { selector: '[role="menuitem"] *' })).toHaveLength(0);
    fireEvent.click(item);
    await waitFor(() =>
      expect(stub.writes[0]).toMatchObject({ op: 'update', resource: 'conversation-labels', id: 'l2', within: 'c1' }),
    );

    fireEvent.click(screen.getByLabelText('Remove tag vip'));
    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({ op: 'remove', resource: 'conversation-labels', id: 'l1', within: 'c1' }),
    );
  });
});

describe('the live subscription re-reads, never merges', () => {
  it('an event for THIS conversation re-reads the thread; another ticket’s event does not', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');
    const before = stub.threadReads;

    stub.emit({ kind: 'message.created', accountId: 'a', conversationId: 'other', messageId: 'm' });
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.threadReads).toBe(before);

    stub.emit({ kind: 'message.created', accountId: 'a', conversationId: 'c1', messageId: 'm' });
    await waitFor(() => expect(stub.threadReads).toBeGreaterThan(before));
  });
});

describe('the failed read', () => {
  it('a failing detail shows an error with retry — never a half-invented header', async () => {
    renderWindow(stubTicket({ failDetailWith: { message: 'not yours to read', retryable: false } }));
    expect(await screen.findByTestId('ticket-detail-error')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-subject')).not.toBeInTheDocument();
  });
});
