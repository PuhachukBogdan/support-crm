/**
 * ⚠️⚠️ **THESE THREE ASSERTIONS PINNED A VALUE THE SERVER REFUSES, so the suite was green while every
 * agent who clicked this bucket got a 400 and a blank screen** (found 2026-08-05, by the operator, on his
 * third report of it — read as a performance problem twice).
 *
 * Feature 032 renamed `resolved` → `solved` and refuses the retired word rather than mapping it. The stub
 * these tests use returns whatever it is handed, so it cannot tell a filter the server ACCEPTS from one it
 * REJECTS — the same shape as `gotchas/a-fake-more-permissive-than-the-library`, one layer up: a double
 * that accepts what the real dependency refuses turns a hard failure into a passing test.
 *
 * ⇒ Track A pins the request the screen COMPOSES. Whether the server accepts it is Track B's, and this
 * bucket had no Track B coverage at all.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, stubConversations } from './test-support';
import { BUCKETS } from './buckets';

/**
 * The bucket rail from Zendesk's Home (`ui-design/screenshots/home.png`), two of the three groups on
 * the operator's instruction: *«Оставь Your work и Completed пока»*.
 *
 * ⛔ **Shared work is deliberately absent**: its contents are *CC'd* and *Following*, and nothing in
 * this product subscribes a person to someone else's conversation. A bucket that could only ever be
 * empty is an affordance for a feature nobody has.
 */
afterEach(() => setDataAccess(new MockDataAccess()));

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

describe('*** the bucket rail ***', () => {
  it('renders the two buckets under their Zendesk group headings', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.getByTestId('bucket-yours')).toBeInTheDocument();
    expect(screen.getByTestId('bucket-completed')).toBeInTheDocument();
    expect(screen.getByText('Your work')).toBeInTheDocument();
    expect(screen.getByText('Completed work')).toBeInTheDocument();
  });

  it('⛔ there is no "Shared work" bucket — CC\'d and Following do not exist here', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByText(/shared work/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cc'd|following/i)).not.toBeInTheDocument();
  });

  it('⭐ choosing a bucket narrows the QUERY, not just the highlight', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-completed'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ status: 'solved' }),
    );
  });

  it('the default bucket asks for no narrowing at all', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(stub.calls[0]!.filters).toEqual({});
  });

  it('⚠️ a bucket CLEARS the filter it collides with — two answers to one question is a defect', async () => {
    // Pick "pending" in the filter, then switch to the Resolved bucket: leaving both would produce an
    // empty list for a reason nothing on screen explains.
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    chooseOption('filter-status', 'pending');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ status: 'pending' }),
    );

    fireEvent.click(screen.getByTestId('bucket-completed'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ status: 'solved' }),
    );
    /**
     * …and the control tells the truth about it rather than showing a value that no longer applies.
     *
     * ⓘ Asserted as the ABSENCE of the stale value, not as the word "Any". Since the filter moved into
     * the column header (9.2b), the funnel spends width on a word only when something is applied — so
     * "shows Any" would now be a claim about the old layout, while "does not still say pending" is the
     * thing that actually protects the agent.
     */
    expect(screen.getByTestId('filter-status')).not.toHaveTextContent(/pending/i);
  });

  it('a filter the bucket does NOT own still applies on top of it', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-completed'));
    chooseOption('filter-channel', 'email');

    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'solved',
        channel: 'email',
      }),
    );
  });

  it('every bucket narrows on a key the route actually declares', () => {
    // A bucket filtering on an undeclared key would be refused by the transport before a request
    // exists — a rail entry that always errors.
    for (const bucket of BUCKETS) {
      for (const key of Object.keys(bucket.filters)) {
        expect(['status', 'channel']).toContain(key);
      }
    }
  });
});

describe('the Status column reads the model of record (feature 032)', () => {
  /**
   * ⭐ The operator's report, verbatim: *«не тянуться статусы тикетов. То есть в solved например тикеты
   * без такого статуса»*.
   *
   * Feature 032 made the status a per-account KEY and deprecated the enum field; the server stopped
   * populating it, so a screen reading `status` got `CONVERSATION_STATUS_UNSPECIFIED` and rendered an
   * empty cell — correctly, for a field that says nothing. Nothing was broken in the data.
   *
   * ⇒ **A deprecated field that still exists is a field somebody is still reading.** Emptying it on the
   * server is only half the change.
   */
  it('renders the key the server sends, not the retired enum', async () => {
    setDataAccess(stubConversations({ count: 1, rowOverrides: { statusKey: 'vip_pending' } }));
    renderInbox();
    await waitFor(() => expect(screen.getByText(/vip_pending/i)).toBeInTheDocument());
  });

  it('falls back to the old field, so an older response still shows something', async () => {
    setDataAccess(
      stubConversations({
        count: 1,
        rowOverrides: { statusKey: '', status: 'CONVERSATION_STATUS_OPEN' },
      }),
    );
    renderInbox();
    await waitFor(() => expect(screen.getByText(/open/i)).toBeInTheDocument());
  });
});
