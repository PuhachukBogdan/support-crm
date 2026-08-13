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
 *   2. set a non-null `subject_source` in the same write.
 *
 * The second is what closes the window before it ever opens. There is no "channel supplies subjects"
 * flag anywhere, and there must not be one: a flag is a second source of truth about a conversation
 * that the row itself already answers.
 *
 * ── ⭐ AMENDED BY FEATURE 033 (roadmap 6.4), which is the channel this spec was written for ────────
 * This file originally prescribed `subject_source = 'auto'`. **Intake writes `'source'` instead** — a
 * third value, added in `subject.derive.ts`.
 *
 * The rule this spec exists to protect is unchanged and is what the tests below still assert: **any
 * non-null source closes the window**, so the customer's own subject line survives every later message.
 * What changed is only which non-null value is written, and the reason is that `auto` makes a claim that
 * would be false: it means *we derived this*. A future screen saying "title generated automatically —
 * rename it?" or a report counting derived titles would then be wrong about every email in the system,
 * where the customer wrote the title themselves. `manual` would be a different lie (no person typed it).
 *
 * Recorded here rather than silently diverging: this file is where 6.4 was told what to do, so it is
 * where 6.4 has to say what it did instead.
 */
describe('a channel-supplied subject is never re-derived (FR-020)', () => {
  const ingested: SubjectBefore = {
    subject: 'Re: withdrawal #4471',
    // ⭐ What feature 033's intake actually writes (FR-028). The assertions below hold for `'auto'` and
    // `'manual'` too — the lock is the non-null-ness, not the word — and the loop in the last test
    // proves that rather than leaving it as a claim.
    subject_source: 'source',
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

  it('all three source values lock it equally — the lock is the value being set, not which value', () => {
    // The claim the amendment above rests on. If a future edit ever made the freeze depend on the WORD,
    // this fails — and the failure mode it protects against is the expensive one: an email whose title
    // is silently replaced by our summary of the customer's first line.
    for (const source of ['auto', 'manual', 'source'] as const) {
      expect(
        decideSubject(
          { subject: 'Re: withdrawal #4471', subject_source: source, category: null },
          {
            authorType: 'player',
            isPrivate: false,
            body: 'а когда уже',
            attachmentKind: null,
            playerMessageCount: 3,
          },
        ),
      ).toBeNull();
    }
  });
});
