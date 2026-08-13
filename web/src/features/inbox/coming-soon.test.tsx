import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { stubConversations } from './test-support';

// jsdom mounts no Next app router — W7's row-open navigation asks for one (same move as shell.test).
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

/**
 * ⭐ The placeholder the operator asked for so a coming feature is not forgotten (2026-08-03):
 * a **search bar** across ticket fields.
 *
 * ⓘ The ARCHIVE placeholder that lived beside it is GONE — W6 made Archive a real bucket (R38: the
 * `closed` category). Its tests went from "inert and says so" to the ordinary bucket assertions in
 * `buckets.test.tsx`, which is the happy ending FR-015b's narrow reversal was for.
 *
 * ── ⚠️ This is a narrow reversal of FR-015b, and the tests are what keep it narrow ──────────────
 * FR-015b forbids a placeholder where a missing feature will go, because *"an affordance for
 * something that does not exist reads as a broken feature"*. Still true of anything that looks
 * operable. What is allowed is a shape that **says what it is** — the same licence R13's reserved
 * telephony slot has.
 *
 * ⇒ The load-bearing assertions here are the negative ones: a placeholder must not be a control, must
 * not take focus, and must not be announced. A greyed-out box that swallows a click is the defect;
 * a labelled, inert one is not.
 */
afterEach(() => setDataAccess(new MockDataAccess()));

function renderInbox() {
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Inbox />
    </Providers>,
  );
}

describe('*** the two placeholders are visible ***', () => {
  /**
   * ⭐ W24 (R43): the search placeholder is GONE — the box is a real control now, and its promise
   * SHRANK to what actually works: the ticket number and the subject (`[номер] тема`, the one field
   * the list shows). Player/assignee/message text stay W39's global screen, so the placeholder's
   * old wording, kept, would have been a lie in the other direction.
   */
  it('the search bar is a REAL control, promising only what works — number and subject', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    expect(screen.queryByTestId('search-coming-soon')).not.toBeInTheDocument();
    const search = screen.getByTestId('inbox-search');
    expect(search.tagName.toLowerCase()).toBe('input');
    expect(search.getAttribute('placeholder') ?? '').toMatch(/number|subject/i);
    expect(search.getAttribute('placeholder') ?? '').not.toMatch(/player|assignee/i);
  });

  it('⭐ Archive is a REAL bucket now — a button, no "soon" badge (W6/R38)', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const archive = screen.getByTestId('bucket-archive');
    expect(archive.tagName.toLowerCase()).toBe('button');
    expect(archive.textContent ?? '').not.toMatch(/soon/i);
  });
});

describe('*** …and neither pretends to work (FR-015b, narrowed) ***', () => {
  it('⭐ the search NARROWS the request — a real control, debounced, over number-or-subject', async () => {
    jest.useFakeTimers();
    try {
      const stub = stubConversations({ count: 3 });
      setDataAccess(stub);
      renderInbox();
      await screen.findByText('Conversation 1', undefined, {
        // findBy polls with real timers; under fake ones, advance manually.
        interval: 0,
      });

      fireEvent.change(screen.getByTestId('inbox-search'), { target: { value: '[1043]' } });
      // Nothing fires per keystroke — the debounce is the point.
      const callsBefore = stub.calls.length;
      jest.advanceTimersByTime(400);
      await waitFor(() =>
        expect(stub.calls[stub.calls.length - 1]!.filters).toMatchObject({ search: '[1043]' }),
      );
      expect(stub.calls.length).toBe(callsBefore + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the real buckets ARE buttons and are announced — nothing in the rail is inert now', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    for (const id of ['bucket-inbox', 'bucket-inwork', 'bucket-waiting', 'bucket-solved', 'bucket-archive']) {
      expect(screen.getByTestId(id).tagName.toLowerCase()).toBe('button');
      expect(screen.getByTestId(id)).not.toHaveAttribute('aria-hidden');
    }
  });
});
