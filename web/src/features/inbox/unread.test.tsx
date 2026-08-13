import { render, screen, waitFor, act } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { InboxUnreadBadge } from '@/components/shell/inbox-unread-badge';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { stubConversations } from './test-support';
import type { SessionState } from '@/session';
import { playUnreadChime } from '../../lib/unread-chime';

/**
 * ⭐ W25 (R23 / 9.12) — the unread badge and its rules, at the altitude jsdom can hold honestly:
 * the badge renders the SERVER's number (never its own arithmetic), the reset act fires when and
 * only when the rules say, the sound is asked for on growth-while-away, and the row dot marks
 * exactly the arrivals since the pre-visit mark. The four rules as BEHAVIOUR — badge grows on a
 * real arrival, resets on a real open — are the live check's, where a real list and a real second
 * browser exist.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => mockPathname,
}));
let mockPathname = '/tickets/abc';

// ⚠️ RELATIVE, not '@/lib/…': the SWC transform rewrites tsconfig aliases in import statements but
// not inside jest.mock's string, so the aliased form is 'module not found' here and only here.
jest.mock('../../lib/unread-chime', () => ({
  playUnreadChime: jest.fn(),
  setUnreadSoundEnabled: jest.fn(),
  unreadSoundEnabled: jest.fn(() => null),
}));

afterEach(() => {
  setDataAccess(new MockDataAccess());
  jest.clearAllMocks();
  mockPathname = '/tickets/abc';
});

const SIGNED_IN: SessionState = {
  kind: 'authenticated',
  userId: 'u1',
  accountId: 'a1',
  roles: [],
  permissionKeys: ['crm.inbox.view'],
};

function renderBadge() {
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={SIGNED_IN}>
      <ul>
        <li className="group/menu-item relative">
          <InboxUnreadBadge />
        </li>
      </ul>
    </Providers>,
  );
}

describe('⭐ the badge — the server’s number, red, capped, and silent about zero', () => {
  it('renders the count the server derived', async () => {
    setDataAccess(stubConversations({ count: 0, unseen: { count: 3 } }));
    renderBadge();
    const badge = await screen.findByTestId('inbox-unread-badge');
    expect(badge).toHaveTextContent('3');
    // The one red on the chrome — R38 freed the colour for exactly this.
    expect(badge.className).toContain('bg-destructive');
  });

  it('⭐ caps the DISPLAY at 99+ — «чтобы не раздувать эту фигнюльку»', async () => {
    setDataAccess(stubConversations({ count: 0, unseen: { count: 120 } }));
    renderBadge();
    expect(await screen.findByTestId('inbox-unread-badge')).toHaveTextContent('99+');
  });

  it('renders NOTHING at zero — an empty red dot would make red mean two things', async () => {
    setDataAccess(stubConversations({ count: 0, unseen: { count: 0 } }));
    renderBadge();
    await waitFor(() => expect(screen.queryByTestId('inbox-unread-badge')).not.toBeInTheDocument());
  });

  it('renders NOTHING on the Inbox route — while you look at the list, nothing is unseen', async () => {
    mockPathname = '/';
    setDataAccess(stubConversations({ count: 0, unseen: { count: 7 } }));
    renderBadge();
    await waitFor(() => expect(screen.queryByTestId('inbox-unread-badge')).not.toBeInTheDocument());
  });

  it('an arrival re-reads the server and the number moves — no client arithmetic anywhere', async () => {
    const s = stubConversations({ count: 0, unseen: { count: 1 } });
    setDataAccess(s);
    renderBadge();
    await screen.findByTestId('inbox-unread-badge');

    s.unseen = { count: 2 };
    act(() => s.emit({ kind: 'conversation.created', accountId: 'a', conversationId: 'c9' }));
    await waitFor(() => expect(screen.getByTestId('inbox-unread-badge')).toHaveTextContent('2'));
  });

  // «звук звенит только на свои» is the SERVER's property — it counts only my slice — so the
  // client never guesses whose ticket it was; it only reacts to the number growing.
  it('⭐ growth while elsewhere asks for the chime', async () => {
    const s = stubConversations({ count: 0, unseen: { count: 1 } });
    setDataAccess(s);
    renderBadge();
    await screen.findByTestId('inbox-unread-badge');
    expect(playUnreadChime).not.toHaveBeenCalled(); // the initial read is not an arrival

    s.unseen = { count: 2 };
    act(() => s.emit({ kind: 'conversation.created', accountId: 'a', conversationId: 'c9' }));
    await waitFor(() => expect(playUnreadChime).toHaveBeenCalledTimes(1));
  });
});

describe('⭐ the Inbox page — the reset act, when and only when the rules say', () => {
  it('opening the Inbox resets (rule 3), and an arrival while OPEN re-marks (rule 2)', async () => {
    const s = stubConversations({ count: 3 });
    setDataAccess(s);
    render(
      <Providers dataAccess={getDataAccess()} sessionSeed={SIGNED_IN}>
        <Inbox />
      </Providers>,
    );
    await screen.findByText('Conversation 1');
    await waitFor(() => expect(s.openedCalls).toBe(1));

    act(() => s.emit({ kind: 'conversation.created', accountId: 'a', conversationId: 'c9' }));
    await waitFor(() => expect(s.openedCalls).toBe(2));
  });

  it('⭐ the row dot marks exactly the arrivals since the PRE-visit mark — older rows stay quiet', async () => {
    // Rows are created at 09:00:05 … 09:00:01 (count-i seconds); the mark sits between rows 2 and 3.
    const s = stubConversations({
      count: 5,
      unseen: { count: 2, openedAt: new Date(Date.UTC(2026, 7, 1, 9, 0, 3, 500)).toISOString() },
    });
    setDataAccess(s);
    render(
      <Providers dataAccess={getDataAccess()} sessionSeed={SIGNED_IN}>
        <Inbox />
      </Providers>,
    );
    await screen.findByText('Conversation 1');
    await waitFor(() => expect(screen.getAllByTestId('row-unseen')).toHaveLength(2));
  });
});
