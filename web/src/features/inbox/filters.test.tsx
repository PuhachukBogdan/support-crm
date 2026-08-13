import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, optionsOf, stubConversations } from './test-support';

/**
 * The toolbar (W6) + T031's transience rule (feature 029, FR-013).
 *
 * ── Where the controls live, and why it changed AGAIN ────────────────────────────────────────────
 * 08-03 moved filters into column-header funnels; the operator's 08-04 snapshots then showed
 * Zendesk's toolbar with his caption *«Отличная вещь — фильтры. Оставим»* — the newer, explicit word
 * wins, so W6 moved them back above the list (`inbox-toolbar.tsx`). What did NOT change: one control
 * per narrowing, options only for things that exist, and nothing persisted.
 *
 * ⚠️ The transience assertion is the ABSENCE OF A WRITE, not the absence of a value. "The filter is
 * gone after a reload" is also satisfied by a filter that was saved and failed to load — which would
 * pass while the product quietly grew the thing the operator ruled out (R11/R16: anything named and
 * kept is a *view*, and views are granted by an admin).
 */
afterEach(() => {
  setDataAccess(new MockDataAccess());
  jest.restoreAllMocks();
});

function renderInbox() {
  // See inbox-states.test.tsx: the composition root binds the gateway on render, so the stub must be
  // passed in rather than only set beforehand.
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

/** Open the bucket whose catalogue slice offers more than one status, so the dropdown renders. */
async function openWaiting() {
  fireEvent.click(screen.getByTestId('bucket-waiting'));
  await screen.findByTestId('filter-status');
}

describe('*** the toolbar: Status ▾ from the account’s own catalogue (W6) ***', () => {
  it('⭐ offers exactly the ACTIVE statuses of the current bucket’s categories, by agent name', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    await openWaiting();
    const options = optionsOf('filter-status');
    // pending + on_hold, active only: the retired `auto_ended_chat` renders on old rows but is not
    // offerable — not settable, not offerable, still readable (feature 032's three-way rule).
    expect(options).toEqual([
      'Any',
      'Pending',
      'VIP Pending',
      'In progress',
      'Follow-up',
      'Supervisor Review – In Progress',
    ]);
  });

  it('⭐ choosing one narrows the request by KEY — inside the bucket, an intersection', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    await openWaiting();
    chooseOption('filter-status', 'Follow-up');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'follow_up',
        statusCategories: 'pending,on_hold',
      }),
    );
  });

  it('a bucket whose slice holds one status renders NO dropdown — a control that cannot choose', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    // The default bucket is Inbox = category `new`, which holds exactly one status.
    expect(screen.queryByTestId('filter-status')).not.toBeInTheDocument();
  });

  it('…and with no catalogue at all the toolbar degrades to chips alone, never to a wrong list', async () => {
    setDataAccess(stubConversations({ count: 3, statuses: [] }));
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-waiting'));
    expect(screen.queryByTestId('filter-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('chip-channel-all')).toBeInTheDocument();
  });
});

describe('*** the channel chips (R38) ***', () => {
  it('⭐ three chips — Все · API · Email — and NO messenger until a transport exists', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const group = screen.getByRole('group', { name: 'Channel' });
    const labels = Array.from(group.querySelectorAll('button')).map((b) => b.textContent);
    // A chip that can only ever match nothing teaches an agent the queue is empty — the standing
    // empty-filter rule, applied to R38's chip row.
    expect(labels).toEqual(['Все', 'API', 'Email']);
  });

  it('a chip narrows the request; «Все» removes the narrowing (no "unset" option exists)', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('chip-channel-email'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ channel: 'email' }),
    );

    fireEvent.click(screen.getByTestId('chip-channel-all'));
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]!.filters as Record<string, unknown>;
      // ~1 in 6 rows carry no channel; they are reached by NOT filtering (FR-011a) — «Все» must
      // therefore remove the parameter, never send some "unset" value.
      expect(last.channel).toBeUndefined();
    });
  });

  it('the chip survives a bucket switch — channel and state are different axes', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('chip-channel-api'));
    fireEvent.click(screen.getByTestId('bucket-solved'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        channel: 'api',
        statusCategories: 'solved',
      }),
    );
  });
});

describe('*** filters are transient and nothing is persisted (FR-013) ***', () => {
  it('⭐ applying a filter and an order writes to NO storage at all', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    await openWaiting();
    chooseOption('filter-status', 'Pending');
    fireEvent.click(screen.getByTestId('chip-channel-email'));
    // Sorting is the column-header triangle, not a dropdown.
    fireEvent.click(screen.getByTestId('sort-lastActivityAt'));

    await waitFor(() => expect(screen.getByTestId('filter-clear')).toBeInTheDocument());
    expect(setItem).not.toHaveBeenCalled();
  });

  it('a remount starts clean — the filter is not remembered', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    const first = renderInbox();
    await screen.findByText('Conversation 1');
    await openWaiting();
    chooseOption('filter-status', 'Pending');
    await screen.findByTestId('filter-clear');
    first.unmount();

    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    // A fresh mount is back in the default bucket asking for its categories and nothing else.
    expect(stub.calls[0]!.filters).toEqual({ statusCategories: 'new' });
    expect(stub.calls[0]!.order).toBe('updated_desc');
  });

  it('⛔ there is no way to save a filter as a view (US3 acceptance 5)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByRole('button', { name: /save.*(view|filter)/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/save this (view|search|filter)/i)).not.toBeInTheDocument();
  });

  it('clear-all removes the person’s narrowings, keeps the bucket’s own, and hides itself', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    await openWaiting();
    chooseOption('filter-status', 'Pending');
    fireEvent.click(screen.getByTestId('chip-channel-email'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'pending',
        channel: 'email',
      }),
    );

    fireEvent.click(screen.getByTestId('filter-clear'));
    await waitFor(() =>
      // The bucket's categories STAY: the bucket is where you are, not a filter you applied.
      expect(stub.calls[stub.calls.length - 1]!.filters).toEqual({
        statusCategories: 'pending,on_hold',
      }),
    );
    expect(screen.queryByTestId('filter-clear')).not.toBeInTheDocument();
  });
});

describe('*** the «Мои» scope (roadmap 5.11) ***', () => {
  it('⭐ scopes the request to MY operator id — the one /me/operator answered', async () => {
    const stub = stubConversations({ count: 3, myOperatorId: 'op-42' });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    const mine = screen.getByTestId('scope-mine');
    await waitFor(() => expect(mine).toBeEnabled());
    fireEvent.click(mine);
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        assigneeOperatorId: 'op-42',
      }),
    );
  });

  it('⚠️ with /me/operator failed the control is DISABLED — never silently un-scoped', async () => {
    const stub = stubConversations({ count: 3, myOperatorId: null });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    // "My tickets" quietly meaning "all tickets" is the confidently-wrong-answer shape (the 012
    // lesson); an unavailable identity must read as unavailable.
    expect(screen.getByTestId('scope-mine')).toBeDisabled();
    for (const call of stub.calls) {
      expect((call.filters as Record<string, unknown>).assigneeOperatorId).toBeUndefined();
    }
  });

  it('the scope survives bucket switches AND "Clear filters" — it is an axis, not a filter', async () => {
    const stub = stubConversations({ count: 3, myOperatorId: 'op-42' });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    const mine = screen.getByTestId('scope-mine');
    await waitFor(() => expect(mine).toBeEnabled());
    fireEvent.click(mine);
    fireEvent.click(screen.getByTestId('bucket-solved'));
    fireEvent.click(screen.getByTestId('chip-channel-email'));
    await screen.findByTestId('filter-clear');
    fireEvent.click(screen.getByTestId('filter-clear'));

    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        assigneeOperatorId: 'op-42',
        statusCategories: 'solved',
      }),
    );
  });
});
