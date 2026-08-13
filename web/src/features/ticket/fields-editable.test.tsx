import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { TicketWindow } from './ticket-window';
import { ContextPanelProvider } from '@/components/shell/context-panel';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, type TicketStub, type TicketStubOptions } from './test-support';

/**
 * ⭐⭐ 2026-08-10 — the left column's remaining two writes, and the affordance that made the
 * operator believe none of them existed.
 *
 * His report, on the shipped screen: *«я всё ещё не вижу возможности менять поля типа бренд, ассайни…
 * player ID… не вижу ни одной причины, почему нельзя сделать placeholder, чтобы его можно было
 * заполнять»*. Three different faults behind one sentence:
 *
 *  1. **Assignee** had no editor at all — only «take it», which can name nobody but the caller.
 *  2. **Player ID** was deliberately read-only. That decision is overruled by his instruction.
 *  3. **Brand** already had one and he could not SEE it, because an editable field and a read-only
 *     field rendered identically until hovered. That is the last describe block here, and it is the
 *     one that would have caught the original mistake.
 *
 * ⚠️ Read every permission title as "…is not RENDERED", never "…is not permitted" — the refusal lives
 * on the server and is asserted there. The same pedantry as `identity-panel.test.tsx`.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

/** Everything the left column's controls need. `crm.conversation.set_brand` is a teamlead+ key. */
const FULL_KEYS = [
  'crm.inbox.view',
  'crm.contact.lookup',
  'crm.conversation.assign',
  'crm.conversation.set_brand',
  'users.list.view',
];

function renderWindow(opts: TicketStubOptions = {}, permissionKeys: string[] = FULL_KEYS) {
  const stub = stubTicket(opts);
  setDataAccess(stub);
  const seed: SessionState = {
    kind: 'authenticated',
    userId: 'u1',
    accountId: 'a1',
    roles: [],
    permissionKeys,
  };
  render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <ContextPanelProvider>
          <TicketWindow id="c1" />
        </ContextPanelProvider>
      </SessionProvider>
    </Providers>,
  );
  return stub;
}

/**
 * Open a Radix DropdownMenu in jsdom: the trigger listens for POINTERDOWN, which jsdom cannot
 * synthesize meaningfully — Enter is the path Radix guarantees regardless, and it is also a real
 * accessibility claim (the menu opens without a mouse).
 */
function openMenu(testId: string) {
  fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' });
}

const writesTo = (stub: TicketStub, resource: string) =>
  stub.writes.filter((w) => w.resource === resource);

describe('*** ⭐ Player ID is a placeholder you can fill (operator, 2026-08-10) ***', () => {
  it('typing an id PLACES it on the ticket — PUT /conversations/:id/player', async () => {
    const stub = renderWindow({ detail: { playerId: '', identityState: 'unidentified' } });
    const field = await screen.findByTestId('field-player-id');

    // The empty field still offers a target — the placeholder, in muted text. Without it there is
    // nothing to click and an editable field is indistinguishable from a broken one.
    expect(field).toHaveTextContent('Add a player ID');

    fireEvent.click(field);
    const input = screen.getByTestId('field-player-id-input');
    fireEvent.change(input, { target: { value: '  player-991  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(writesTo(stub, 'conversation-player')).toHaveLength(1));
    const write = writesTo(stub, 'conversation-player')[0]!;
    expect(write.op).toBe('update');
    expect(write.within).toBe('c1');
    // Trimmed, and sent as `playerId` — the field name the gateway's DTO requires.
    expect(write.payload).toEqual({ playerId: 'player-991' });
  });

  it('⚠️ re-reads the DETAIL afterwards — this write moves identityState as well as the id', async () => {
    const stub = renderWindow({ detail: { playerId: '', identityState: 'unidentified' } });
    fireEvent.click(await screen.findByTestId('field-player-id'));
    const before = stub.detailReads;

    const input = screen.getByTestId('field-player-id-input');
    fireEvent.change(input, { target: { value: 'player-991' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Not a local merge: a ticket must never render as identified while the server still calls it
    // unidentified — the right rail's player card is keyed off both facts.
    await waitFor(() => expect(stub.detailReads).toBeGreaterThan(before));
  });

  it('⛔ an EMPTY commit writes nothing — clearing is the detach flow, which carries a warning', async () => {
    const stub = renderWindow({ detail: { playerId: 'player-7' } });
    fireEvent.click(await screen.findByTestId('field-player-id'));

    const input = screen.getByTestId('field-player-id-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // A blank must not become a silent detach: ADR 0044 §5 requires the person be told what a detach
    // costs BEFORE it happens, and that dialog lives in IdentityPanel.
    await waitFor(() => expect(screen.getByTestId('field-player-id')).toBeInTheDocument());
    expect(writesTo(stub, 'conversation-player')).toHaveLength(0);
  });

  it('⛔ NOT RENDERED as an editor without `crm.contact.lookup` — the key its route requires', async () => {
    renderWindow({}, ['crm.inbox.view', 'crm.conversation.assign', 'users.list.view']);
    await screen.findByTestId('ticket-fields');

    expect(screen.queryByTestId('field-player-id')).not.toBeInTheDocument();
    // …and the value is still READ: refusing the write is not refusing the fact.
    expect(screen.getByTestId('ticket-fields')).toHaveTextContent('player-7');
  });
});

describe('*** ⭐ Assignee is a chooser over the account’s staff, by name ***', () => {
  it('offers colleagues by NAME with their presence, and assigns by Operator.id', async () => {
    const stub = renderWindow();
    const field = await screen.findByTestId('field-assignee');
    await waitFor(() => expect(stub.operatorLookups.length).toBeGreaterThan(0));

    openMenu('field-assignee');
    // The name plus the state — handing work to somebody on a break is legitimate, so the state is
    // STATED rather than used to hide the option.
    expect(await screen.findByText('Nina Petrova — On shift')).toBeInTheDocument();
    // No display name set ⇒ the email, which is a value a colleague recognises. Never a fabricated
    // stand-in name (ADR 0044 §1 forbids those outright).
    expect(screen.getByText('oleg@example.test — Away')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('field-assignee-option-op-nina'));

    await waitFor(() => expect(writesTo(stub, 'conversation-assignee')).toHaveLength(1));
    const write = writesTo(stub, 'conversation-assignee')[0]!;
    expect(write.op).toBe('update');
    // ⚠️ The OPERATOR id, not the auth user id. An assignment points at `users.Operator.id`; sending
    // `u-nina` here would be accepted-looking and assign nobody.
    expect(write.payload).toEqual({ operatorId: 'op-nina' });
    expect(field).toBeInTheDocument();
  });

  it('asks the translation only for the ids the staff list returned — never an open-ended list', async () => {
    const stub = renderWindow();
    await screen.findByTestId('field-assignee');
    await waitFor(() => expect(stub.operatorLookups.length).toBeGreaterThan(0));

    // The disabled colleague is not even asked about; the route refuses an absent list with a 400,
    // so a screen hoping for "everyone" would be asking a question the contract does not have.
    expect(stub.operatorLookups[0]!).toEqual(['u-nina', 'u-oleg']);
  });

  it('⚠️ a person with no ACTIVE operator profile is not offered — fail-closed, as the rpc promises', async () => {
    // Nina is active in auth and absent from the translation: the rpc answers with active profiles
    // only, and the difference between what was asked and what came back is the whole answer.
    renderWindow({ resolvedOperators: [{ operatorId: 'op-oleg', authUserId: 'u-oleg', state: 'online' }] });
    await screen.findByTestId('field-assignee');

    openMenu('field-assignee');
    await screen.findByText('oleg@example.test — On shift');
    expect(screen.queryByText(/Nina Petrova/)).not.toBeInTheDocument();
  });

  it('⭐ Unassigned is reachable, and it is a DELETE — not a PUT with an empty operator', async () => {
    const stub = renderWindow({ detail: { assigneeOperatorId: 'op-nina' } });
    await screen.findByTestId('field-assignee');

    openMenu('field-assignee');
    fireEvent.click(await screen.findByTestId('field-assignee-clear'));

    await waitFor(() => expect(writesTo(stub, 'conversation-assignee')).toHaveLength(1));
    const write = writesTo(stub, 'conversation-assignee')[0]!;
    // "Nobody holds this" is the state every ticket is created in, so a field that could be filled
    // and never emptied would be a one-way door — `setPriority`'s lesson, one property over.
    expect(write.op).toBe('remove');
    expect(write.payload).toBeUndefined();
  });

  it('⛔ without `users.list.view` there is no chooser — the raw id, and «take it» still works', async () => {
    const stub = renderWindow({ detail: { assigneeOperatorId: 'op-someone' } }, [
      'crm.inbox.view',
      'crm.conversation.assign',
    ]);
    await screen.findByTestId('ticket-fields');

    expect(screen.queryByTestId('field-assignee')).not.toBeInTheDocument();
    // ⚠️ The id, NOT a dash: "somebody holds this and I cannot resolve who" and "nobody holds this"
    // are opposite facts, and only the id states the first honestly.
    expect(screen.getByTestId('ticket-fields')).toHaveTextContent('op-someone');
    // The control that needs neither of the chooser's keys is untouched.
    fireEvent.click(screen.getByTestId('take-it'));
    await waitFor(() => expect(writesTo(stub, 'conversation-assignee')).toHaveLength(1));
    expect(writesTo(stub, 'conversation-assignee')[0]!.payload).toEqual({ operatorId: 'op-me' });
  });

  it('a failed staff read degrades the FIELD, never the window', async () => {
    renderWindow({ failStaffWith: { message: 'nope', retryable: false } });
    // The thread and the record still render — a convenience read must not take a ticket down.
    expect(await screen.findByTestId('ticket-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('field-assignee')).not.toBeInTheDocument();
    expect(screen.getByTestId('ticket-subject')).toBeInTheDocument();
  });
});

describe('*** ⭐⭐ an editable field LOOKS different from a read-only one at rest ***', () => {
  /**
   * The fault behind *«я всё ещё не вижу возможности менять поля типа бренд»*: Brand had been an
   * `EditableChoice` for hours and rendered as bare text, exactly like Channel beside it. The only
   * difference was a hover background — a signal you must already suspect exists to go looking for.
   *
   * ⓘ Asserting the MARK's presence rather than a colour: a later edit that removed the icon and kept
   * the hover state would reproduce the operator's report precisely, and pass any test written about
   * the hover.
   */
  it('every editable field carries a mark; the read-only ones carry none', async () => {
    renderWindow();
    await screen.findByTestId('ticket-fields');

    for (const id of ['field-brand', 'field-status', 'field-priority', 'field-assignee', 'field-player-id']) {
      const field = screen.getByTestId(id);
      expect(field.querySelector('svg')).not.toBeNull();
    }

    // Channel is genuinely read-only (the reply path follows it) and must not claim otherwise.
    const channel = screen.getByTitle(/Not editable — the reply path follows it/);
    expect(channel.querySelector('svg')).toBeNull();
  });

  it('⛔ a chooser with nothing to choose shows no chevron — a control that cannot open must not offer', async () => {
    // The brands read came back empty (refused, or an account with none configured yet).
    renderWindow({ brands: [] });
    const brand = await screen.findByTestId('field-brand');

    expect(brand).toBeDisabled();
    // ⚠️ The mark is what promises a click does something. On a control that cannot open, keeping it
    // would be the same lie as omitting it from one that can — the fault this block exists for, in
    // the other direction.
    expect(brand.querySelector('svg')).toBeNull();
    /**
     * ⚠️ And the VALUE is still the ticket's own brand id, not the placeholder and not a dash.
     *
     * An id the brands read does not cover is a real state, and showing it is the only honest answer
     * — the same rule a retired status obeys on an old ticket: not settable, not offerable, still
     * readable. A placeholder here would claim the ticket has no brand, which is a different fact.
     */
    expect(brand).toHaveTextContent('brand-a');
  });
});
