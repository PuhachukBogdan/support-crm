import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, optionsOf, stubConversations } from './test-support';

// jsdom mounts no Next app router — W7's row-open navigation asks for one (same move as shell.test).
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * The header funnels (restored 2026-08-06 — *«Мы зачем по-твоему их добавляли? Верни»*) +
 * T031's transience rule (FR-013) + ⭐⭐ the self-scope.
 *
 * ── The self-scope is the load-bearing block here ────────────────────────────────────────────────
 * Operator, 2026-08-06: *«Менеджеру и так только его тикеты приходят в инбокс и только его должны
 * быть видны в open, solved, pending»*. So EVERY request carries `assigneeOperatorId = mine`, no
 * control can turn it off, and while the identity is unknown NO request exists — an unscoped list
 * would be both the confidently-wrong answer and a disclosure.
 *
 * ⚠️ The transience assertion is the ABSENCE OF A WRITE, not the absence of a value (R11/R16:
 * anything named and kept is a *view*, and views are granted by an admin).
 */
afterEach(() => {
  setDataAccess(new MockDataAccess());
  jest.restoreAllMocks();
});

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

/** The bucket whose catalogue slice offers more than one status, so the status funnel renders. */
async function openPending() {
  fireEvent.click(screen.getByTestId('bucket-pending'));
  await screen.findByTestId('filter-status');
}

describe('*** ⭐⭐ every request is scoped to the signed-in agent ***', () => {
  it('every list call carries assigneeOperatorId = the id /me/operator answered', async () => {
    const stub = stubConversations({ count: 3, myOperatorId: 'op-42' });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-solved'));
    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(1));
    for (const call of stub.calls) {
      expect((call.filters as Record<string, unknown>).assigneeOperatorId).toBe('op-42');
    }
  });

  it('⛔ there is NO control that widens the scope — no «Мои», no toggle, nothing', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByTestId('scope-mine')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /все тикеты|all tickets|everyone/i })).not.toBeInTheDocument();
  });

  it('⚠️ with the identity FAILED the screen shows an error with retry — never everyone’s queue', async () => {
    const stub = stubConversations({ count: 3, myOperatorId: null });
    setDataAccess(stub);
    renderInbox();

    expect(await screen.findByTestId('dt-error')).toBeInTheDocument();
    // The load-bearing half: not one request was composed without the scope.
    expect(stub.calls).toHaveLength(0);
  });
});

describe('*** each filter lives in ITS OWN column header ***', () => {
  it('⭐ the three funnels sit inside the columns they narrow', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();

    for (const key of ['status', 'channel', 'priority']) {
      const trigger = screen.getByTestId(`filter-${key}`);
      expect(trigger.closest('th')).not.toBeNull();
    }
    // The funnel sits beside that column's own sort control — one header, both of its controls.
    expect(screen.getByTestId('sort-lastActivityAt').closest('th')).not.toBeNull();
  });

  it('a column with no filter of its own gets no funnel', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByTestId('filter-subject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-playerId')).not.toBeInTheDocument();
  });

  it('⭐ the status funnel offers the ACTIVE statuses of THIS bucket, by agent name', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();

    // pending + on_hold, active only: the retired `auto_ended_chat` renders on old rows but is not
    // offerable — not settable, not offerable, still readable (feature 032's three-way rule).
    expect(optionsOf('filter-status')).toEqual([
      'Any',
      'Pending',
      'VIP Pending',
      'In progress',
      'Follow-up',
      'Supervisor Review – In Progress',
    ]);
  });

  it('…and in a bucket whose slice holds ONE status it renders nothing — a control that cannot choose', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    // The default bucket is Inbox = category `new`, which holds exactly one status.
    expect(screen.queryByTestId('filter-status')).not.toBeInTheDocument();
    // The other two funnels are unaffected: their vocabularies do not depend on the bucket.
    expect(screen.getByTestId('filter-channel')).toBeInTheDocument();
    expect(screen.getByTestId('filter-priority')).toBeInTheDocument();
  });

  it('choosing a status narrows by KEY inside the bucket’s categories', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();

    chooseOption('filter-status', 'Follow-up');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'follow_up',
        statusCategories: 'pending,on_hold',
      }),
    );
  });

  it('⭐ the priority funnel narrows the request — the operator counts it among the three', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    chooseOption('filter-priority', 'high');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ priority: 'high' }),
    );
  });

  it('the funnels are present in Solved and Archive too — channel and priority always, status when it can choose', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    for (const bucket of ['solved', 'archive']) {
      fireEvent.click(screen.getByTestId(`bucket-${bucket}`));
      await waitFor(() => {
        expect(screen.getByTestId('filter-channel')).toBeInTheDocument();
        expect(screen.getByTestId('filter-priority')).toBeInTheDocument();
      });
    }
  });
});

describe('*** filters are transient and nothing is persisted (FR-013) ***', () => {
  it('⭐ applying filters and an order writes to NO storage at all', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();

    chooseOption('filter-status', 'Pending');
    chooseOption('filter-channel', 'email');
    fireEvent.click(screen.getByTestId('sort-lastActivityAt'));

    await waitFor(() => expect(screen.getByTestId('filter-clear')).toBeInTheDocument());
    expect(setItem).not.toHaveBeenCalled();
  });

  it('a remount starts clean — the filter is not remembered', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    const first = renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();
    chooseOption('filter-status', 'Pending');
    await screen.findByTestId('filter-clear');
    first.unmount();

    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    // A fresh mount is back in the default bucket asking for its categories, its scope, nothing else.
    expect(stub.calls[0]!.filters).toEqual({
      statusCategories: 'new',
      assigneeOperatorId: 'op-me',
    });
    expect(stub.calls[0]!.order).toBe('updated_desc');
  });

  it('⛔ there is no way to save a filter as a view (US3 acceptance 5)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByRole('button', { name: /save.*(view|filter)/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/save this (view|search|filter)/i)).not.toBeInTheDocument();
  });

  it('clear-all removes the person’s narrowings, keeps the bucket’s own and the scope, hides itself', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');
    await openPending();

    chooseOption('filter-status', 'Pending');
    chooseOption('filter-channel', 'email');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'pending',
        channel: 'email',
      }),
    );

    fireEvent.click(screen.getByTestId('filter-clear'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toEqual({
        statusCategories: 'pending,on_hold',
        assigneeOperatorId: 'op-me',
      }),
    );
    expect(screen.queryByTestId('filter-clear')).not.toBeInTheDocument();
  });

  it('⚠️ the channel funnel offers no "unset" option — those rows stay reachable by clearing', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const options = optionsOf('filter-channel');
    expect(options).toContain('Any');
    expect(options.filter((o) => /none|unset|empty|no channel/i.test(o ?? ''))).toHaveLength(0);
  });
});
