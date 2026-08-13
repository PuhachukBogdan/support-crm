import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, optionsOf, stubConversations } from './test-support';

/**
 * T031 (feature 029, FR-013) — **transient means transient.**
 *
 * ⚠️ The interesting assertion is the ABSENCE OF A WRITE, not the absence of a value. "The filter is
 * gone after a reload" is also satisfied by a filter that was saved and failed to load — which would
 * pass while the product quietly grew the thing the operator ruled out. Agents have no saved queries
 * (R11/R16): anything named and kept is a *view*, and views are granted by an admin.
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

describe('*** each filter lives in ITS OWN column header (9.2b) ***', () => {
  it('⭐ the funnel is inside the column it narrows, and the toolbar no longer holds it', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    for (const key of ['status', 'channel']) {
      const trigger = screen.getByTestId(`filter-${key}`);
      // Structural on purpose: every behavioural assertion in this file would pass with the controls
      // sitting anywhere on the page. The operator asked for them *«прям в эту плашку»* — in the header
      // of the column they narrow — so that placement is the requirement, and it needs its own claim.
      expect(trigger.closest('th')).not.toBeNull();
      expect(screen.getByTestId('inbox-filters').contains(trigger)).toBe(false);
    }
    // The funnel sits beside that column's own sort control — one header, both of its controls.
    expect(screen.getByTestId('sort-lastActivityAt').closest('th')).not.toBeNull();
  });

  it('a column with no filter of its own gets no funnel', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    // `subject` is a free-text column: the route accepts no such filter, and a funnel offering one
    // would be the control-that-does-nothing this screen keeps deleting.
    expect(screen.queryByTestId('filter-subject')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-playerId')).not.toBeInTheDocument();
  });
});

describe('*** filters are transient and nothing is persisted (FR-013) ***', () => {
  it('⭐ applying a filter and an order writes to NO storage at all', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    chooseOption('filter-status', 'pending');
    chooseOption('filter-channel', 'email');
    // Sorting is the column-header triangle now, not a dropdown.
    fireEvent.click(screen.getByTestId('sort-lastActivityAt'));

    await waitFor(() => expect(screen.getByTestId('filter-clear')).toBeInTheDocument());
    expect(setItem).not.toHaveBeenCalled();
  });

  it('a remount starts clean — the filter is not remembered', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    const first = renderInbox();
    await screen.findByText('Conversation 1');
    chooseOption('filter-status', 'pending');
    await screen.findByTestId('filter-clear');
    first.unmount();

    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    // The header funnel carries no leftover value (it shows one only when applied — see the note in
    // `buckets.test.tsx`), and the request proves it: a remount asks for everything.
    expect(screen.getByTestId('filter-status')).not.toHaveTextContent(/pending/i);
    expect(stub.calls[0]!.filters).toEqual({});
    expect(stub.calls[0]!.order).toBe('updated_desc');
  });

  it('⛔ there is no way to save a filter as a view (US3 acceptance 5)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByRole('button', { name: /save.*(view|filter)/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/save this (view|search|filter)/i)).not.toBeInTheDocument();
  });

  it('clear-all removes every filter in one action, and then hides itself', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    chooseOption('filter-status', 'pending');
    chooseOption('filter-channel', 'email');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'pending',
        channel: 'email',
      }),
    );

    fireEvent.click(screen.getByTestId('filter-clear'));
    await waitFor(() => expect(stub.calls[stub.calls.length - 1]!.filters).toEqual({}));
    expect(screen.queryByTestId('filter-clear')).not.toBeInTheDocument();
  });

  it('⚠️ the channel filter offers no "unset" option — those rows stay reachable by clearing', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const options = optionsOf('filter-channel');
    // The wire cannot express "has no channel" as a filter value — an empty string means "no filter".
    // Offering one would be a control that silently does something else. ~1 in 6 rows have no channel
    // and are reached by NOT filtering (FR-011a).
    expect(options).toContain('Any');
    expect(options.filter((o) => /none|unset|empty|no channel/i.test(o ?? ''))).toHaveLength(0);
  });
});
