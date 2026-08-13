import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { TicketWindow } from './ticket-window';
import { ContextPanelProvider } from '@/components/shell/context-panel';
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
      <ContextPanelProvider><TicketWindow id={id} /></ContextPanelProvider>
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

/**
 * ⭐ 2026-08-10 — **Enter sends, and the send BUTTON is gone** (operator: «убрать кнопку Send Reply и
 * чтобы просто на Enter отправлялись сообщения»). Every test below drives the keyboard, because that
 * is now the only way to send without also changing the status.
 */
function pressEnter(shift = false) {
  fireEvent.keyDown(screen.getByTestId('composer-body'), { key: 'Enter', shiftKey: shift });
}

describe('the composer composes the request (and only the request)', () => {
  it("sends kind:'note' VERBATIM, scoped to this conversation", async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('composer-mode-note'));
    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'internal only' } });
    pressEnter();

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
    openMenu('composer-submit');
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

  it('a picked file becomes a CHIP (wire field `id`), and the message carries its uploadId', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } });
    // The chip — not the block, which also renders the error line (the first live run passed on
    // an upload that had failed into an error message; this selector cannot).
    await screen.findByLabelText('Remove attachment shot.png');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'see attached' } });
    pressEnter();
    await waitFor(() => expect(stub.writes.filter((w) => w.resource === 'conversation-messages')).toHaveLength(1));
    expect(stub.writes.find((w) => w.resource === 'conversation-messages')).toMatchObject({
      payload: { body: 'see attached', uploadIds: ['u-1'] },
    });
  });

  it('a failed send names itself and composes NOTHING further (the refusal)', async () => {
    const stub = stubTicket({ failSendWith: { message: 'The server refused this message.', retryable: false } });
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'x' } });
    pressEnter();

    expect(await screen.findByTestId('composer-error')).toHaveTextContent('refused');
    expect(stub.writes).toHaveLength(1); // the one attempt; no status write followed it
  });
});

/** ⭐ 2026-08-10 — the composer the operator asked for: keyboard sends, one button sets the status. */
describe('the composer after the 2026-08-10 rework', () => {
  it('⭐ the Send reply button is GONE — the keyboard is how a message is sent', async () => {
    renderWindow(stubTicket());
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('composer-send')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-submit-as')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-submit')).toBeInTheDocument();
  });

  it('⭐ SHIFT+Enter is a newline, not a send — the multi-line answer stays possible', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'line one' } });
    pressEnter(true);

    // Nothing left the screen. The old rule (Ctrl+Enter) existed because a half-sent reply to a
    // customer cannot be retracted; Shift+Enter is what keeps that case one keystroke away.
    await waitFor(() => expect(stub.writes).toHaveLength(0));
  });

  it('a bare Enter on an EMPTY box sends nothing', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');
    pressEnter();
    await waitFor(() => expect(stub.writes).toHaveLength(0));
  });

  it('⭐⭐ «Submit as …» with NOTHING typed changes the status and posts NO message', async () => {
    // «Close it, nothing to say» is an ordinary act. Before the rework every submit posted first, so
    // this path would have written an empty message into the customer's thread.
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    openMenu('composer-submit');
    fireEvent.click(await screen.findByText('Submit as Solved'));

    await waitFor(() => expect(stub.writes).toHaveLength(1));
    expect(stub.writes[0]).toMatchObject({
      op: 'update',
      resource: 'conversation-status',
      within: 'c1',
      payload: { status: 'solved' },
    });
    expect(stub.writes.filter((w) => w.resource === 'conversation-messages')).toHaveLength(0);
  });
});

/**
 * ⭐ 2026-08-10 — the left column and the title became editable in place (operator: «все поля слева
 * должны быть плейсхолдерами, то есть их можно было поменять»).
 *
 * ⚠️ What these pin is the WRITE each control composes, not that a menu opened. A chooser that
 * renders perfectly and PATCHes the wrong path is the defect worth a test.
 */
describe('the ticket’s own properties are edited in place', () => {
  it('⭐ the title is a placeholder-style editor that PATCHes the subject', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('ticket-subject-edit'));
    fireEvent.change(screen.getByTestId('ticket-subject-edit-input'), {
      target: { value: 'выплата задерживается' },
    });
    fireEvent.keyDown(screen.getByTestId('ticket-subject-edit-input'), { key: 'Enter' });

    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({
        op: 'update',
        resource: 'conversation-subject',
        within: 'c1',
        payload: { subject: 'выплата задерживается' },
      }),
    );
  });

  it('⚠️ an UNCHANGED title writes nothing — a no-op PATCH is an audit entry saying nothing happened', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    const heading = await screen.findByTestId('ticket-subject');
    const before = heading.textContent ?? '';

    fireEvent.click(screen.getByTestId('ticket-subject-edit'));
    fireEvent.change(screen.getByTestId('ticket-subject-edit-input'), { target: { value: before } });
    fireEvent.keyDown(screen.getByTestId('ticket-subject-edit-input'), { key: 'Enter' });

    await waitFor(() => expect(stub.writes.filter((w) => w.resource === 'conversation-subject')).toHaveLength(0));
  });

  it('Escape abandons the edit and writes nothing', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.click(screen.getByTestId('ticket-subject-edit'));
    fireEvent.change(screen.getByTestId('ticket-subject-edit-input'), { target: { value: 'typed then abandoned' } });
    fireEvent.keyDown(screen.getByTestId('ticket-subject-edit-input'), { key: 'Escape' });

    expect(screen.queryByTestId('ticket-subject-edit-input')).not.toBeInTheDocument();
    await waitFor(() => expect(stub.writes.filter((w) => w.resource === 'conversation-subject')).toHaveLength(0));
  });

  it('⭐ Priority is a chooser over the PRODUCT’s three, and it PATCHes its own route', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    openMenu('field-priority');
    fireEvent.click(await screen.findByTestId('field-priority-option-high'));

    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({
        op: 'update',
        resource: 'conversation-priority',
        within: 'c1',
        payload: { priority: 'high' },
      }),
    );
  });

  it('⭐⭐ Priority can be CLEARED — the state every ticket is created in', async () => {
    // The one-way-door bug: a field that can be set and never returned to empty. `''` must survive
    // the whole way down, so nothing on the path may treat it as "absent".
    const stub = stubTicket({ detail: { priority: 'high' } });
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    openMenu('field-priority');
    fireEvent.click(await screen.findByTestId('field-priority-clear'));

    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({
        resource: 'conversation-priority',
        payload: { priority: '' },
      }),
    );
  });

  it('Status is chosen from the ACCOUNT’s catalogue and PATCHes the status route', async () => {
    const stub = stubTicket();
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    openMenu('field-status');
    fireEvent.click(await screen.findByTestId('field-status-option-solved'));

    await waitFor(() =>
      expect(stub.writes.at(-1)).toMatchObject({
        resource: 'conversation-status',
        within: 'c1',
        payload: { status: 'solved' },
      }),
    );
  });

  it('⛔ Channel, Created and Updated are NOT editable — they are facts, not properties', async () => {
    // Recorded as a claim rather than left to look like an oversight: "cannot be edited" and "nobody
    // built the editor" are indistinguishable from the screen, which is what made Priority confusing.
    renderWindow(stubTicket());
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('field-channel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('field-created')).not.toBeInTheDocument();
    expect(screen.queryByTestId('field-updated')).not.toBeInTheDocument();
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

describe('W8 — the composer’s pickers', () => {
  const TEMPLATES = {
    macros: [{ id: 'mac1', name: 'triage', actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }] }],
    canned: [{ id: 'can1', name: 'greeting', body: 'Thanks for reaching out.' }],
  };

  it('a template INSERTS its text into the draft — it never sends anything', async () => {
    const stub = stubTicket(TEMPLATES);
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    fireEvent.change(screen.getByTestId('composer-body'), { target: { value: 'Hello,' } });
    openMenu('composer-canned');
    fireEvent.click(await screen.findByText('greeting'));

    expect(screen.getByTestId('composer-body')).toHaveValue('Hello,\nThanks for reaching out.');
    expect(stub.writes).toHaveLength(0); // insertion is a draft edit, not a request
  });

  it('applying a macro POSTs to the macro under the conversation, then re-reads detail + labels', async () => {
    const stub = stubTicket(TEMPLATES);
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');
    const detailReadsBefore = stub.detailReads;

    openMenu('composer-macro');
    fireEvent.click(await screen.findByText('triage'));

    await waitFor(() => expect(stub.writes).toHaveLength(1));
    expect(stub.writes[0]).toMatchObject({
      op: 'update',
      resource: 'conversation-macros',
      id: 'mac1',
      within: 'c1',
    });
    expect(stub.writes[0]!.payload).toBeUndefined(); // the macro IS the payload; nothing rides along
    await waitFor(() => expect(stub.detailReads).toBeGreaterThan(detailReadsBefore));
  });

  it('a refused macro names itself (all-or-nothing server-side, so nothing partial to render)', async () => {
    const stub = stubTicket({
      ...TEMPLATES,
      failMacroWith: { message: 'macro needs a permission you lack', retryable: false },
    });
    renderWindow(stub);
    await screen.findByTestId('ticket-subject');

    openMenu('composer-macro');
    fireEvent.click(await screen.findByText('triage'));
    expect(await screen.findByTestId('fields-error')).toHaveTextContent('permission');
  });

  it('⛔ with no templates configured, neither picker renders — no button that leads nowhere', async () => {
    renderWindow(stubTicket());
    await screen.findByTestId('ticket-subject');
    expect(screen.queryByTestId('composer-macro')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-canned')).not.toBeInTheDocument();
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

/**
 * ⭐⭐ W27 / 036 (9.16) — the SHELF on the window: the banner, its one verb, and the two ways in.
 *
 * The gates here are RENDER-only (`crm.conversation.shelf.manage`); the server refuses at both
 * tiers regardless. What these tests pin: a shelved ticket SAYS so before anyone types into it,
 * the way back is one visible act, and the way IN is offered only to holders — on ordinary
 * tickets only (the banner owns the shelved state's verbs).
 */
describe('*** W27: suspend · delete · restore on the window ***', () => {
  const seedWith = (keys: string[]) =>
    ({
      kind: 'authenticated',
      userId: 'u1',
      accountId: 'a1',
      roles: [],
      permissionKeys: ['crm.inbox.view', 'crm.conversation.reply', ...keys],
    }) as const;

  function renderAs(stub: TicketStub, keys: string[], id = 'c1') {
    setDataAccess(stub);
    return render(
      <Providers dataAccess={getDataAccess()} sessionSeed={seedWith(keys) as never}>
        <ContextPanelProvider><TicketWindow id={id} /></ContextPanelProvider>
      </Providers>,
    );
  }

  it('⭐ a manage-key holder suspends an ORDINARY ticket from the ⋮ menu — one PUT, the shelf route', async () => {
    const stub = stubTicket();
    renderAs(stub, ['crm.conversation.shelf.manage']);
    fireEvent.keyDown(await screen.findByTestId('ticket-more-actions'), { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('ticket-suspend'));

    await waitFor(() => {
      const write = stub.writes.find((w) => w.resource === 'conversation-shelf');
      expect(write).toMatchObject({ op: 'update', within: 'c1', payload: { state: 'suspended' } });
    });
  });

  it('⭐ a SHELVED ticket wears the banner, and Restore is its one verb — the ⋮ menu yields', async () => {
    const stub = stubTicket({ detail: { shelvedState: 'deleted' } });
    renderAs(stub, ['crm.conversation.shelf.manage']);

    const banner = await screen.findByTestId('shelf-banner');
    expect(banner).toHaveTextContent('Deleted (recoverable)');
    expect(banner).toHaveTextContent('Nothing is erased');
    // The shelved state's verbs live on the banner; a second entry point would be two answers.
    expect(screen.queryByTestId('ticket-more-actions')).toBeNull();

    fireEvent.click(screen.getByTestId('shelf-restore'));
    await waitFor(() => {
      const write = stub.writes.find((w) => w.resource === 'conversation-shelf');
      expect(write).toMatchObject({ op: 'update', within: 'c1', payload: { state: '' } });
    });
  });

  it('without the manage key: the banner still SAYS shelved, but offers no verb — and no ⋮ menu', async () => {
    const stub = stubTicket({ detail: { shelvedState: 'suspended' } });
    renderAs(stub, []);

    const banner = await screen.findByTestId('shelf-banner');
    expect(banner).toHaveTextContent('Suspended');
    expect(screen.queryByTestId('shelf-restore')).toBeNull();
    expect(screen.queryByTestId('ticket-more-actions')).toBeNull();
    expect(stub.writes.filter((w) => w.resource === 'conversation-shelf')).toHaveLength(0);
  });
});
