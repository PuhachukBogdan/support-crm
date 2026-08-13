import { render, screen } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Inbox } from './inbox';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { stubConversations } from './test-support';

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
  it('the search bar is shown, and says it is coming', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const search = screen.getByTestId('search-coming-soon');
    expect(search).toBeInTheDocument();
    expect(search.textContent ?? '').toMatch(/soon/i);
    // Names the fields it will cover, so the shape communicates the plan.
    expect(search.textContent ?? '').toMatch(/player|subject|assignee/i);
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
  it('⭐ the search placeholder is not a control and cannot take focus', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    const search = screen.getByTestId('search-coming-soon');
    expect(search.tagName.toLowerCase()).not.toBe('input');
    expect(search.tagName.toLowerCase()).not.toBe('button');
    expect(search).toHaveAttribute('aria-hidden');
    expect(search.querySelector('input, button, [tabindex]')).toBeNull();
  });

  it('the real buckets ARE buttons and are announced — nothing in the rail is inert now', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderInbox();
    await screen.findByText('Conversation 1');

    for (const id of ['bucket-inbox', 'bucket-open', 'bucket-pending', 'bucket-solved', 'bucket-archive']) {
      expect(screen.getByTestId(id).tagName.toLowerCase()).toBe('button');
      expect(screen.getByTestId(id)).not.toHaveAttribute('aria-hidden');
    }
  });
});
