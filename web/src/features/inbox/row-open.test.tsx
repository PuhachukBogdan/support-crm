import { render, screen, fireEvent } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubConversations } from './test-support';

/**
 * W7 — a row in the queue OPENS its ticket (subpoint 2.6; the window itself is
 * `features/ticket/`). What jsdom can prove here is the wiring: the click composes the right
 * URL, and the selection checkbox does NOT navigate. Whether a real pointer event lands on the
 * row at all is the browser check's claim (`deploy/local/w7-browser-check.mjs`).
 */

// The shared spy: `mock`-prefixed so jest's hoisted factory may close over it.
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
});

it('clicking a row navigates to /tickets/<its id>', async () => {
  setDataAccess(stubConversations({ count: 3 }));
  renderInbox();

  const cell = await screen.findByText('Conversation 1');
  fireEvent.click(cell);

  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/tickets/conv-0001');
});

it('the id rides the path URL-ENCODED — an id is data, never structure', async () => {
  setDataAccess(stubConversations({ count: 1, rowOverrides: { id: 'a/b' } }));
  renderInbox();

  fireEvent.click(await screen.findByText('Conversation 1'));
  expect(mockPush).toHaveBeenCalledWith('/tickets/a%2Fb');
});

// ⓘ The checkbox-does-not-navigate rule is asserted in the composite's own suite
// (`data-table.test.tsx`), where selection is rendered unconditionally — here it would pass
// vacuously whenever the harness carries no bulk permission (`gotchas/vacuous-pass-in-live-scripts`).
