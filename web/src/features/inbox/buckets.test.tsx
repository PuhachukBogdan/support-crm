/**
 * ⭐ The R39 rail — FOUR buttons on CATEGORIES, then the archive as a labelled SECTION (W23).
 * Supersedes R38's five (W6); what R38 decided and R39 keeps: categories only, no numbers.
 *
 * ── Why every bucket assertion here is about `statusCategories` and never a status key ───────────
 * The pre-R38 rail pinned the literal `resolved` — a key feature 032 had retired — and the suite was
 * green while every agent who clicked got a 400 and a blank screen (found 2026-08-05, by the
 * operator, on his third report). The stub returns whatever it is handed, so it cannot tell a filter
 * the server accepts from one it refuses (`gotchas/a-fake-more-permissive-than-the-library`, one
 * layer up). Categories are the closed six the server derives keys from itself, so there is no
 * account-specific word here left to rot — and the detector test below proves a planted key would
 * be caught. R39's «согласования» decision leans on the same rule: approvals are a status-KEY
 * narrowing (`supervisor_review`), so they are the FUNNEL's job inside «В работе», never a button.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, stubConversations } from './test-support';
import { ALL_BUCKETS, ARCHIVE_BUCKETS, BUCKETS, BUCKET_OWNED_KEYS } from './buckets';

// jsdom mounts no Next app router — W7's row-open navigation asks for one (same move as shell.test).
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

afterEach(() => setDataAccess(new MockDataAccess()));

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

describe('*** the R39 rail: four buttons on categories, then the archive section ***', () => {
  it('renders the four working buckets in R39 order, and the archive below its own heading', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const rail = screen.getByTestId('bucket-rail');
    const labels = Array.from(rail.querySelectorAll('button')).map((b) => b.textContent);
    // R39's own names, as written in Document 6 and the plan's W23 row (both operator-reviewed —
    // and both newer than the 2026-08-06 «на английском», which named the rail R39 replaced).
    expect(labels).toEqual(['Inbox', 'В работе', 'Ждут клиента', 'Решённые', 'Весь архив']);
    // R47: the archive is SEPARATED — a line and a heading — and is still this same rail, not a page.
    const separator = screen.getByTestId('archive-separator');
    expect(separator).toHaveTextContent('Архив');
    // The separator sits BETWEEN the working buckets and the archive button in the DOM.
    const order = Array.from(rail.children).map((el) => el.getAttribute('data-testid'));
    expect(order.indexOf('archive-separator')).toBeGreaterThan(order.indexOf('bucket-solved'));
    expect(order.indexOf('archive-separator')).toBeLessThan(order.indexOf('bucket-archive'));
  });

  it('⭐ the default bucket is Inbox = new + open — the queue: new, and where the answer is on US', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(stub.calls[0]!.filters).toMatchObject({ statusCategories: 'new,open' });
    // ⭐⭐ …and the scope rides the very first request: the screen never asks unscoped.
    expect(stub.calls[0]!.filters).toMatchObject({ assigneeOperatorId: 'op-me' });
  });

  it('⭐ «В работе» asks for on_hold alone — work in progress left the waiting room', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-inwork'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        statusCategories: 'on_hold',
      }),
    );
  });

  it('«Ждут клиента» asks for pending alone — we wait on THEM, nothing parked hides here', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-waiting'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        statusCategories: 'pending',
      }),
    );
  });

  it('⭐ «Весь архив» narrows to closed — a real section entry, same list, not a page', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-archive'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        statusCategories: 'closed',
      }),
    );
  });

  it('⭐ «на согласовании» is the FUNNEL inside «В работе» — supervisor_review by key, never a button', async () => {
    // R39's deciding argument: supervisor_review shares on_hold with in_progress/follow_up, so a
    // fifth button would filter by a status KEY — the defect class the categories rule prevents.
    // The funnel narrows by key INSIDE the bucket's categories; this proves the exact ask.
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-inwork'));
    await screen.findByTestId('filter-status');
    chooseOption('filter-status', 'Supervisor Review – In Progress');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'supervisor_review',
        statusCategories: 'on_hold',
      }),
    );
  });

  it('⛔ no button carries a number (R38: counts are 9.2a’s, unread is 9.12’s)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const rail = screen.getByTestId('bucket-rail');
    expect(rail.textContent).not.toMatch(/\d/);
  });

  it('⭐⭐ every bucket narrows by CATEGORY, never by a status key — and the detector works', () => {
    // ALL of them — the archive section's entries obey the same rule as the four working buckets.
    for (const bucket of ALL_BUCKETS) {
      expect(Object.keys(bucket.filters)).toEqual(['statusCategories']);
      // The six closed categories are the only words allowed here.
      for (const c of bucket.categories) {
        expect(['new', 'open', 'pending', 'on_hold', 'solved', 'closed']).toContain(c);
      }
      expect(bucket.filters.statusCategories).toBe(bucket.categories.join(','));
    }
    expect(ALL_BUCKETS.length).toBe(BUCKETS.length + ARCHIVE_BUCKETS.length);
    // Planted input: the shape the pre-R38 rail died of. If this stops matching, the guard above
    // has gone blind, not the codebase clean.
    const planted = { filters: { status: 'resolved' } };
    expect(Object.keys(planted.filters)).not.toEqual(['statusCategories']);
  });

  it('⚠️ switching bucket clears the exact-status filter — two answers to one question is a defect', async () => {
    // Pick "VIP Pending" inside «Ждут клиента», then switch to «Решённые»: leaving the key in force
    // would intersect to an empty page for a reason nothing on screen explains.
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-waiting'));
    await screen.findByTestId('filter-status');
    chooseOption('filter-status', 'VIP Pending');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'vip_pending',
        statusCategories: 'pending',
      }),
    );

    fireEvent.click(screen.getByTestId('bucket-solved'));
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]!.filters as Record<string, unknown>;
      expect(last.statusCategories).toBe('solved');
      expect(last.status).toBeUndefined();
    });
  });

  it('a filter the bucket does NOT own still applies on top of it', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    chooseOption('filter-channel', 'email');
    fireEvent.click(screen.getByTestId('bucket-solved'));

    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        statusCategories: 'solved',
        channel: 'email',
      }),
    );
  });

  it('every bucket narrows on a key the route actually declares', () => {
    // A bucket filtering on an undeclared key would be refused by the transport before a request
    // exists — a rail entry that always errors.
    for (const bucket of ALL_BUCKETS) {
      for (const key of Object.keys(bucket.filters)) {
        expect(BUCKET_OWNED_KEYS as readonly string[]).toContain(key);
      }
    }
  });
});

describe('⭐ W24 (R43) — the Subject column is ONE field: [номер] тема', () => {
  it('renders the number before the subject', async () => {
    setDataAccess(stubConversations({ count: 1, rowOverrides: { reference: '1043', subject: 'Не пришёл депозит' } }));
    renderInbox();
    await waitFor(() => expect(screen.getByText(/Не пришёл депозит/)).toBeInTheDocument());
    expect(screen.getByText('[1043]')).toBeInTheDocument();
  });

  it('a ticket with NO subject reads «[1043] —», never bare brackets', async () => {
    setDataAccess(stubConversations({ count: 1, rowOverrides: { reference: '1043', subject: '' } }));
    renderInbox();
    await waitFor(() => expect(screen.getByText('[1043]')).toBeInTheDocument());
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('a pre-backfill row with no number degrades to the subject alone — no empty brackets', async () => {
    setDataAccess(stubConversations({ count: 1, rowOverrides: { reference: '', subject: 'старый тикет' } }));
    renderInbox();
    await waitFor(() => expect(screen.getByText('старый тикет')).toBeInTheDocument());
    expect(screen.queryByText(/\[\s*\]/)).not.toBeInTheDocument();
  });
});

describe('the Status column reads the model of record (feature 032), labelled by the catalogue (W6)', () => {
  /**
   * ⭐ The operator's report, verbatim: *«не тянуться статусы тикетов. То есть в solved например тикеты
   * без такого статуса»* — feature 032 deprecated the enum field, the server stopped populating it, and
   * a screen still reading it rendered empty cells. The column reads `statusKey`; W6 adds the catalogue
   * join on top, so the cell shows the account's agent-facing NAME.
   */
  it('renders the catalogue’s agent name for the key the server sends', async () => {
    setDataAccess(stubConversations({ count: 1, rowOverrides: { statusKey: 'vip_pending' } }));
    renderInbox();
    await waitFor(() => expect(screen.getByText('VIP Pending')).toBeInTheDocument());
  });

  it('falls back to the KEY when the catalogue does not know it — a retired word still renders', async () => {
    setDataAccess(
      stubConversations({ count: 1, rowOverrides: { statusKey: 'bespoke_status' } }),
    );
    renderInbox();
    await waitFor(() => expect(screen.getByText(/bespoke_status/i)).toBeInTheDocument());
  });

  it('falls back to the old enum field, so an older response still shows something', async () => {
    setDataAccess(
      stubConversations({
        count: 1,
        rowOverrides: { statusKey: '', status: 'CONVERSATION_STATUS_OPEN' },
      }),
    );
    renderInbox();
    await waitFor(() => expect(screen.getAllByText(/open/i).length).toBeGreaterThan(0));
  });
});
