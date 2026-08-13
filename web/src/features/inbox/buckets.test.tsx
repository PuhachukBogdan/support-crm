/**
 * ⭐ The R38 rail — five buttons on CATEGORIES (W6).
 *
 * ── Why every bucket assertion here is about `statusCategories` and never a status key ───────────
 * The previous rail pinned the literal `resolved` — a key feature 032 had retired — and the suite was
 * green while every agent who clicked got a 400 and a blank screen (found 2026-08-05, by the
 * operator, on his third report). The stub returns whatever it is handed, so it cannot tell a filter
 * the server accepts from one it refuses (`gotchas/a-fake-more-permissive-than-the-library`, one
 * layer up). Categories are the closed six the server derives keys from itself, so there is no
 * account-specific word here left to rot — and the detector test below proves a planted key would
 * be caught.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { chooseOption, stubConversations } from './test-support';
import { BUCKETS, BUCKET_OWNED_KEYS } from './buckets';

afterEach(() => setDataAccess(new MockDataAccess()));

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

describe('*** the R38 rail: five buttons on categories ***', () => {
  it('renders exactly the five buckets, in R38 order, with the operator’s own labels', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const rail = screen.getByTestId('bucket-rail');
    const labels = Array.from(rail.querySelectorAll('button')).map((b) => b.textContent);
    // Plain English on the operator's instruction (2026-08-06) — the first cut spelled «Ждут».
    expect(labels).toEqual(['Inbox', 'Open', 'Pending', 'Solved', 'Archive']);
  });

  it('the default bucket is Inbox — the tickets waiting for a FIRST answer', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(stub.calls[0]!.filters).toMatchObject({ statusCategories: 'new' });
    // ⭐⭐ …and the scope rides the very first request: the screen never asks unscoped.
    expect(stub.calls[0]!.filters).toMatchObject({ assigneeOperatorId: 'op-me' });
  });

  it('⭐ Pending asks for the UNION pending,on_hold — one button, two categories', async () => {
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-pending'));
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        statusCategories: 'pending,on_hold',
      }),
    );
  });

  it('⭐ Archive is a real bucket now — the `closed` category, not a placeholder', async () => {
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

  it('⛔ no button carries a number (R38: counts are 9.2a’s, unread is 9.12’s)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const rail = screen.getByTestId('bucket-rail');
    expect(rail.textContent).not.toMatch(/\d/);
  });

  it('⭐⭐ every bucket narrows by CATEGORY, never by a status key — and the detector works', () => {
    for (const bucket of BUCKETS) {
      expect(Object.keys(bucket.filters)).toEqual(['statusCategories']);
      // The six closed categories are the only words allowed here.
      for (const c of bucket.categories) {
        expect(['new', 'open', 'pending', 'on_hold', 'solved', 'closed']).toContain(c);
      }
      expect(bucket.filters.statusCategories).toBe(bucket.categories.join(','));
    }
    // Planted input: the shape the previous rail died of. If this stops matching, the guard above
    // has gone blind, not the codebase clean.
    const planted = { filters: { status: 'resolved' } };
    expect(Object.keys(planted.filters)).not.toEqual(['statusCategories']);
  });

  it('⚠️ switching bucket clears the exact-status filter — two answers to one question is a defect', async () => {
    // Pick "VIP Pending" inside «Ждут», then switch to Solved: leaving the key in force would
    // intersect to an empty page for a reason nothing on screen explains.
    const stub = stubConversations({ count: 3 });
    setDataAccess(stub);
    renderInbox();
    await screen.findByText('Conversation 1');

    fireEvent.click(screen.getByTestId('bucket-pending'));
    await screen.findByTestId('filter-status');
    chooseOption('filter-status', 'VIP Pending');
    await waitFor(() =>
      expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({
        status: 'vip_pending',
        statusCategories: 'pending,on_hold',
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
    for (const bucket of BUCKETS) {
      for (const key of Object.keys(bucket.filters)) {
        expect(BUCKET_OWNED_KEYS as readonly string[]).toContain(key);
      }
    }
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
