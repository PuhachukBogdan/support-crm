import { decideSubject, type SubjectBefore } from './subject.derive';

/**
 * T026 (feature 023, FR-020) — a channel that brings its own subject keeps it.
 *
 * ⚠️ **The email channel does not exist yet** (roadmap 6.4). This spec ships now anyway, and that is
 * deliberate: the rule is a one-line consequence of how the window works, and writing it down here
 * means 6.4 *inherits* it instead of re-deciding it under delivery pressure — which is how a channel
 * ends up overwriting a real "Re: withdrawal #4471" with a derived title, or worse, deriving one from
 * the quoted signature at the bottom of a reply.
 *
 * The contract for any such channel is exactly two things, and no new machinery:
 *   1. at ingestion, set `subject` from the channel's own value,
 *   2. set `subject_source = 'auto'` in the same write.
 *
 * The second is what closes the window before it ever opens. There is no "channel supplies subjects"
 * flag anywhere, and there must not be one: a flag is a second source of truth about a conversation
 * that the row itself already answers.
 */
describe('a channel-supplied subject is never re-derived (FR-020)', () => {
  const ingested: SubjectBefore = {
    subject: 'Re: withdrawal #4471',
    subject_source: 'auto',
    category: null,
  };

  it('survives the customer’s later messages, substantive or not', () => {
    for (const body of ['не пришёл депозит со вчера, что делать', 'привет', '???']) {
      for (const playerMessageCount of [1, 2, 3, 9]) {
        expect(
          decideSubject(ingested, {
            authorType: 'player',
            isPrivate: false,
            body,
            attachmentKind: null,
            playerMessageCount,
          }),
        ).toBeNull();
      }
    }
  });

  it('survives the first staff reply', () => {
    expect(
      decideSubject(ingested, {
        authorType: 'operator',
        isPrivate: false,
        body: 'we are looking into it',
        attachmentKind: null,
        playerMessageCount: 0,
      }),
    ).toBeNull();
  });

  it('survives an attachment-only follow-up', () => {
    expect(
      decideSubject(ingested, {
        authorType: 'player',
        isPrivate: false,
        body: '',
        attachmentKind: 'image',
        playerMessageCount: 2,
      }),
    ).toBeNull();
  });

  it('a channel that sets the subject but FORGETS the source is still open — the source is the lock', () => {
    // Stated as a test rather than a comment because it is the mistake 6.4 will actually make: the
    // title looks set, and then the third customer message closes the window over the top of it.
    const halfIngested: SubjectBefore = {
      subject: 'Re: withdrawal #4471',
      subject_source: null,
      category: null,
    };
    expect(
      decideSubject(halfIngested, {
        authorType: 'operator',
        isPrivate: false,
        body: 'looking',
        attachmentKind: null,
        playerMessageCount: 0,
      }),
    ).toEqual({ subject: 'Re: withdrawal #4471', subject_source: 'auto' });
  });
});
