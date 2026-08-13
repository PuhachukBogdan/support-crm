import { render, screen } from '@testing-library/react';
import { Providers } from '../providers';
import DashboardHome from './page';
// The composition root binds the real gateway on render, so the stub is passed in explicitly.
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { stubConversations } from '@/features/inbox/test-support';

// jsdom mounts no Next app router — W7's row-open navigation asks for one (same move as shell.test).
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * T017 (feature 029, FR-001) — **the landing route IS the Inbox.**
 *
 * ⚠️ This file used to test the D2 demo dashboard: KPI stat cards over mock records. That screen is
 * deleted, and the roadmap named it as the thing this point removes — *"the demo dashboard built at
 * D2 is exactly the homepage this deletes"*. The tests are rewritten rather than dropped, because the
 * route still needs an owner: what changed is which screen it must render.
 *
 * The assertions that the stat cards are GONE matter as much as the ones that the list is there. A
 * half-replaced landing — new list, old KPI tiles above it — would look plausible and would be the
 * "no homepage" decision quietly not taken.
 */
afterEach(() => {
  setDataAccess(new MockDataAccess()); // reset the default binding
});

describe('the landing route is the Inbox (FR-001)', () => {
  it('renders the ticket queue with no intermediate page and no click', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    render(
      <Providers dataAccess={getDataAccess()}>
        <DashboardHome />
      </Providers>,
    );
    expect(await screen.findByText('Conversation 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('⛔ the D2 KPI stat cards are GONE — there is no homepage above the queue', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    render(
      <Providers dataAccess={getDataAccess()}>
        <DashboardHome />
      </Providers>,
    );
    await screen.findByText('Conversation 1');
    for (const label of ['Open', 'Pending', 'Resolved', 'Urgent']) {
      expect(screen.queryByRole('heading', { name: label })).not.toBeInTheDocument();
    }
    // ⚠️ Was `queryByText(/All tickets/i)` — the Archive bucket is now legitimately labelled that, so
    // the assertion has to name the demo card rather than a phrase. Its description is unique to it.
    expect(screen.queryByText(/Mock data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Swapped for the gateway/i)).not.toBeInTheDocument();
  });

  it('⛔ offers no "Recommended" order — nothing computes urgency (roadmap 4.20)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    render(
      <Providers dataAccess={getDataAccess()}>
        <DashboardHome />
      </Providers>,
    );
    await screen.findByText('Conversation 1');
    // Sorting is the column-header triangles now — the dropdown is gone, so the assertion moves to
    // the headers: nothing anywhere on the screen may claim to know what is urgent.
    const headers = (await screen.findAllByRole('columnheader')).map((h) => h.textContent ?? '');
    expect(headers.length).toBeGreaterThan(4);
    for (const header of headers) expect(header).not.toMatch(/recommend|priorit(y|ised)? order|urgen/i);
    expect(screen.queryByTestId('inbox-sort')).not.toBeInTheDocument();
  });

  it('⛔ shows no views panel and no placeholder for one (FR-015b, roadmap 9.2a)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    render(
      <Providers dataAccess={getDataAccess()}>
        <DashboardHome />
      </Providers>,
    );
    await screen.findByText('Conversation 1');
    // An affordance for something that does not exist reads as a broken feature, not as a promise.
    expect(screen.queryByText(/shared views?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });
});
