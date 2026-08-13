import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, stubConversations } from './test-support';

/**
 * T018 (feature 029, FR-003) — **empty, filtered-to-nothing and failed-to-load are three different
 * facts and must read as three different things.**
 *
 * ⚠️ The assertions compare the three renderings to EACH OTHER, not just "something appeared". Three
 * identical empty boxes would satisfy a weaker check, and that is the actual failure mode: an agent
 * who has narrowed too far concludes there is no work. "You have no tickets" and "nothing matches
 * this filter" lead to opposite next actions.
 */
afterEach(() => {
  setDataAccess(new MockDataAccess());
});

function renderInbox() {
  // ⚠️ The stub is handed to `Providers` rather than only set via `setDataAccess`: the composition
  // root now BINDS the real gateway on render (it never did before, which is how the Inbox shipped
  // reading the demo store), so an injection made before rendering would be overwritten.
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

describe('*** the three states are visibly different (FR-003) ***', () => {
  it('an empty queue says the queue is empty', async () => {
    setDataAccess(stubConversations({ count: 0 }));
    renderInbox();
    expect(await screen.findByText(/no tickets in this bucket/i)).toBeInTheDocument();
  });

  it('a filter that matches nothing says THAT, not that the queue is empty', async () => {
    setDataAccess(stubConversations({ count: 0 }));
    renderInbox();
    await screen.findByText(/no tickets in this bucket/i);

    fireEvent.click(screen.getByTestId('bucket-pending'));
    await screen.findByTestId('filter-status');
    chooseOption('filter-status', 'Pending');

    expect(await screen.findByText(/no tickets match these filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/no tickets in this bucket/i)).not.toBeInTheDocument();
  });

  it('a failed load is distinct from both, and offers a retry', async () => {
    setDataAccess(
      stubConversations({
        count: 3,
        failWith: { message: 'gateway unreachable', retryable: true },
      }),
    );
    renderInbox();

    expect(await screen.findByTestId('dt-error')).toBeInTheDocument();
    // Not an empty state wearing a different label.
    expect(screen.queryByText(/no tickets/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('⭐ the three renderings are not the same text as each other', async () => {
    const texts: string[] = [];

    setDataAccess(stubConversations({ count: 0 }));
    const empty = renderInbox();
    await screen.findByText(/no tickets in this bucket/i);
    texts.push(empty.container.textContent ?? '');
    empty.unmount();

    setDataAccess(stubConversations({ count: 0 }));
    const filtered = renderInbox();
    await screen.findByText(/no tickets in this bucket/i);
    fireEvent.click(screen.getByTestId('bucket-pending'));
    await screen.findByTestId('filter-status');
    chooseOption('filter-status', 'Pending');
    await screen.findByText(/no tickets match these filters/i);
    texts.push(filtered.container.textContent ?? '');
    filtered.unmount();

    setDataAccess(
      stubConversations({ count: 3, failWith: { message: 'gateway unreachable', retryable: true } }),
    );
    const failed = renderInbox();
    await screen.findByTestId('dt-error');
    texts.push(failed.container.textContent ?? '');
    failed.unmount();

    expect(new Set(texts).size).toBe(3);
  });
});

describe('*** what the screen ASKS FOR (the request it composes) ***', () => {
  it('sends the default order and no filters on first load', async () => {
    const stub = stubConversations({ count: 2 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(stub.calls[0]).toMatchObject({ order: 'updated_desc', filters: {} });
    expect(stub.calls[0]!.cursor).toBeNull();
  });

  it('⭐ RESETS the cursor when the order changes — a token belongs to one sequence (R8)', async () => {
    const stub = stubConversations({ count: 120, pageSize: 50 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(1));
    expect(stub.calls[1]!.cursor).not.toBeNull(); // paged forward

    fireEvent.click(screen.getByTestId('sort-lastActivityAt'));
    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(2));

    const afterOrderChange = stub.calls[stub.calls.length - 1]!;
    expect(afterOrderChange.order).toBe('updated_asc');
    // The whole point: continuing with the old token would page a DIFFERENT sequence — rows repeated,
    // rows missing, and no error to see. The server refuses it; this stops anyone meeting the refusal.
    expect(afterOrderChange.cursor).toBeNull();
  });

  it('RESETS the cursor when a filter changes, for the same reason', async () => {
    const stub = stubConversations({ count: 120, pageSize: 50 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(stub.calls.length).toBeGreaterThan(1));

    chooseOption('filter-channel', 'email');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ channel: 'email' }),
    );
    expect(stub.calls[stub.calls.length - 1]!.cursor).toBeNull();
  });

  it('⛔ never asks for a player: there is no read-by-ids and no name to fetch (R9)', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    // A second request per page — or worse, per row — is the N+1 Principle VII forbids, and it would
    // return no name anyway: the product stores none at any tier.
    expect(stub.calls.every((c) => c.filters?.playerId === undefined)).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });
});
