import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { PlayerNotes } from './player-notes';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, type TicketStubOptions } from './test-support';
import type { PlayerNoteWire } from './use-player-notes';

/**
 * W35 / feature 040 — the notes area (R35 · U17).
 *
 * What only a rendered test can state: that the warning KEEPS the author's text, that a refusal makes
 * the area ABSENT rather than empty, that every row is signed, and that no control exists for editing or
 * deleting a note.
 *
 * ⚠️ jsdom has no layout and no frame rate — how this LOOKS is judged in a real browser, in both themes
 * (`deploy/local/w35-browser-check.mjs`). These are the claims a DOM can carry.
 */

const NOTE = (over: Partial<PlayerNoteWire> = {}): PlayerNoteWire => ({
  id: 'n-1',
  body: 'клиент играет по выходным',
  authorRef: 'auth-am-1',
  authorDisplayName: 'Anna M',
  createdAt: '2026-08-13T09:00:00.000Z',
  patternKinds: [],
  ...over,
});

function renderNotes(opts: TicketStubOptions = {}) {
  const stub = stubTicket(opts);
  setDataAccess(stub);
  const view = render(
    <Providers dataAccess={getDataAccess()}>
      <PlayerNotes playerId="seed-player-001" brandId="brand-a" />
    </Providers>,
  );
  return { stub, view };
}

describe('*** every note is SIGNED (the operator’s decision of 2026-08-13) ***', () => {
  it('shows the author’s name and the time on each row', async () => {
    renderNotes({ notes: [NOTE()] });
    expect(await screen.findByTestId('player-note')).toBeInTheDocument();
    expect(screen.getByTestId('player-note-author')).toHaveTextContent('Anna M');
    expect(screen.getByText('клиент играет по выходным')).toBeInTheDocument();
    // The exact instant stays available (title/dateTime) while the label reads relatively.
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', '2026-08-13T09:00:00.000Z');
  });

  it('⭐ falls back to the author REFERENCE when no name resolves — never to a blank byline', async () => {
    // The case the block exists for: W32 hands the portfolio over when somebody LEAVES, so their notes
    // are precisely the ones whose author may no longer resolve. A blank byline would read as unsigned.
    renderNotes({ notes: [NOTE({ authorDisplayName: '', authorRef: 'auth-departed-9' })] });
    expect(await screen.findByTestId('player-note-author')).toHaveTextContent('auth-departed-9');
  });

  it('marks a note that carried contact-shaped text, quietly', async () => {
    renderNotes({ notes: [NOTE({ patternKinds: ['phone'] })] });
    expect(await screen.findByTestId('player-note-flag')).toBeInTheDocument();
  });

  it('a plain note carries no mark', async () => {
    renderNotes({ notes: [NOTE()] });
    await screen.findByTestId('player-note');
    expect(screen.queryByTestId('player-note-flag')).not.toBeInTheDocument();
  });
});

describe('*** append-only is visible: no control can change or remove a note ***', () => {
  it('offers no edit or delete affordance on a row', async () => {
    renderNotes({ notes: [NOTE()] });
    const row = await screen.findByTestId('player-note');
    expect(row.querySelectorAll('button')).toHaveLength(0);
    // …and the screen says so, so the absence reads as a rule rather than as a missing feature.
    expect(screen.getByText(/cannot be edited or deleted/i)).toBeInTheDocument();
  });
});

describe('*** the four states, and the fifth ***', () => {
  it('loading first', () => {
    renderNotes({ notes: [NOTE()] });
    expect(screen.getByTestId('player-notes-loading')).toBeInTheDocument();
  });

  it('empty says what the area is FOR, in words', async () => {
    renderNotes({ notes: [] });
    expect(await screen.findByTestId('player-notes-empty')).toBeInTheDocument();
    expect(screen.getByText(/No notes yet/i)).toBeInTheDocument();
  });

  it('a broken read says so and offers a retry — never poses as an empty list', async () => {
    renderNotes({ failNotesWith: { message: 'nope', retryable: true, code: 'unavailable' } });
    expect(await screen.findByTestId('player-notes-error')).toBeInTheDocument();
    expect(screen.queryByTestId('player-notes-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('⭐ a REFUSED read makes the whole area absent — not empty, not an error', async () => {
    const { view } = renderNotes({
      failNotesWith: { message: 'You do not have access to this.', retryable: false, code: 'refused' },
    });
    await waitFor(() => expect(screen.queryByTestId('player-notes')).not.toBeInTheDocument());
    // An empty list would ANSWER a question about a customer ("nobody wrote anything") to somebody with
    // no clearance for the answer. Absence is the only honest render.
    expect(view.container.textContent).not.toMatch(/no notes/i);
    expect(screen.queryByTestId('player-notes-add')).not.toBeInTheDocument();
  });

  it('busy: the Add button says what is happening and cannot be pressed twice', async () => {
    renderNotes({ notes: [] });
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: 'новая мысль' } });
    fireEvent.click(screen.getByTestId('player-notes-add'));
    // The click is synchronous up to the await, so the busy label is observable.
    await waitFor(() => expect(screen.getByTestId('player-notes-add')).toBeDisabled());
  });
});

describe('*** the composer ***', () => {
  it('will not add an empty or whitespace-only note', async () => {
    renderNotes({ notes: [] });
    await screen.findByTestId('player-notes-empty');
    expect(screen.getByTestId('player-notes-add')).toBeDisabled();
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: '   ' } });
    expect(screen.getByTestId('player-notes-add')).toBeDisabled();
  });

  it('stores a note, clears the box, and shows it immediately', async () => {
    const { stub } = renderNotes({ notes: [] });
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: 'новая мысль' } });
    fireEvent.click(screen.getByTestId('player-notes-add'));

    expect(await screen.findByTestId('player-note')).toBeInTheDocument();
    expect(screen.getByText('новая мысль')).toBeInTheDocument();
    expect(screen.getByTestId('player-notes-draft')).toHaveValue('');
    // The write carried the brand and an idempotence reference — a retry must be one row.
    const write = stub.writes.find((w) => w.resource === 'player-notes')!;
    expect(write.payload).toMatchObject({ brandId: 'brand-a', body: 'новая мысль', acknowledged: false });
    expect(String((write.payload as { clientRef: string }).clientRef).length).toBeGreaterThan(4);
    expect(write.within).toBe('seed-player-001');
  });

  it('⌘/Ctrl+Enter adds it (the keyboard floor)', async () => {
    renderNotes({ notes: [] });
    await screen.findByTestId('player-notes-empty');
    const box = screen.getByTestId('player-notes-draft');
    fireEvent.change(box, { target: { value: 'с клавиатуры' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText('с клавиатуры')).toBeInTheDocument();
  });

  it('a plain Enter does NOT add — a note is allowed to have paragraphs', async () => {
    const { stub } = renderNotes({ notes: [] });
    await screen.findByTestId('player-notes-empty');
    const box = screen.getByTestId('player-notes-draft');
    fireEvent.change(box, { target: { value: 'первая строка' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(stub.writes.filter((w) => w.resource === 'player-notes')).toHaveLength(0);
  });

  it('a failed save says so and KEEPS the text', async () => {
    renderNotes({
      notes: [],
      failAddNoteWith: { message: 'Something went wrong. Please try again.', retryable: true },
    });
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: 'важное' } });
    fireEvent.click(screen.getByTestId('player-notes-add'));

    expect(await screen.findByTestId('player-notes-save-error')).toBeInTheDocument();
    expect(screen.getByTestId('player-notes-draft')).toHaveValue('важное');
  });
});

describe('*** the warning: at entry, keeps the text, and saving is still possible (U17) ***', () => {
  const flagged: TicketStubOptions = {
    notes: [],
    addNoteAnswer: { outcome: 'needs_acknowledgement', patternKinds: ['phone'] },
  };

  it('⭐ names what it recognised, stores nothing, and leaves the text in the box', async () => {
    const { stub } = renderNotes(flagged);
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), {
      target: { value: 'звонить на +34 600 123 456' },
    });
    fireEvent.click(screen.getByTestId('player-notes-add'));

    const warning = await screen.findByTestId('player-notes-warning');
    expect(warning).toHaveTextContent(/phone number/i);
    expect(warning).toHaveAttribute('role', 'alert');
    // Nothing was stored…
    expect(screen.queryByTestId('player-note')).not.toBeInTheDocument();
    // …and the sentence somebody just wrote is still there. This is the moment it must not be lost.
    expect(screen.getByTestId('player-notes-draft')).toHaveValue('звонить на +34 600 123 456');
    expect(stub.writes.filter((w) => w.resource === 'player-notes')).toHaveLength(1);
  });

  it('“Add anyway” stores it — the warning is not a refusal', async () => {
    const { stub } = renderNotes(flagged);
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), {
      target: { value: 'звонить на +34 600 123 456' },
    });
    fireEvent.click(screen.getByTestId('player-notes-add'));
    fireEvent.click(await screen.findByTestId('player-notes-acknowledge'));

    expect(await screen.findByTestId('player-note')).toBeInTheDocument();
    const acked = stub.writes.filter((w) => w.resource === 'player-notes').at(-1)!;
    // ⚠️ The acknowledged request carries the SAME body the server judged — not whatever the box holds a
    // moment later, which is what a re-read of the draft would send.
    expect(acked.payload).toMatchObject({
      acknowledged: true,
      body: 'звонить на +34 600 123 456',
    });
  });

  it('“Let me edit it” dismisses the warning and stores nothing', async () => {
    const { stub } = renderNotes(flagged);
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: 'тел +34600123456' } });
    fireEvent.click(screen.getByTestId('player-notes-add'));
    fireEvent.click(await screen.findByTestId('player-notes-edit-instead'));

    await waitFor(() =>
      expect(screen.queryByTestId('player-notes-warning')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('player-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('player-notes-draft')).toHaveValue('тел +34600123456');
    expect(stub.writes.filter((w) => w.resource === 'player-notes')).toHaveLength(1);
  });

  it('the warning explains the consequence, not just the shape', async () => {
    renderNotes(flagged);
    await screen.findByTestId('player-notes-empty');
    fireEvent.change(screen.getByTestId('player-notes-draft'), { target: { value: 'тел +34600123456' } });
    fireEvent.click(screen.getByTestId('player-notes-add'));
    const warning = await screen.findByTestId('player-notes-warning');
    // U17's deterrent only works if the author knows what follows: readable by everyone with notes
    // access, and recorded.
    expect(warning).toHaveTextContent(/recorded/i);
    expect(warning).toHaveTextContent(/readable/i);
  });
});

describe('*** it asks nothing when there is nothing to ask about ***', () => {
  it('no player and no brand ⇒ no read', async () => {
    const stub = stubTicket({ notes: [NOTE()] });
    setDataAccess(stub);
    render(
      <Providers dataAccess={getDataAccess()}>
        <PlayerNotes playerId="" brandId="" />
      </Providers>,
    );
    await waitFor(() => expect(stub.noteReads).toBe(0));
  });
});
