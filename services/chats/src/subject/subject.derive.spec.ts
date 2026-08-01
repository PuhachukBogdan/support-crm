import {
  attachmentKindOf,
  attachmentTitle,
  CLOSING_PLAYER_MESSAGE_COUNT,
  decideSubject,
  MAX_SUBJECT_LENGTH,
  toTitle,
  type SubjectBefore,
  type SubjectMessageFacts,
} from './subject.derive';

/**
 * T025 (feature 023, roadmap 4.18). The interesting cases are all boundaries: which message closed
 * the window, and what was in hand when it did.
 */

const OPEN: SubjectBefore = { subject: null, subject_source: null, category: null };

const player = (over: Partial<SubjectMessageFacts> = {}): SubjectMessageFacts => ({
  authorType: 'player',
  isPrivate: false,
  body: '',
  attachmentKind: null,
  playerMessageCount: 1,
  ...over,
});

const staffReply = (over: Partial<SubjectMessageFacts> = {}): SubjectMessageFacts => ({
  authorType: 'operator',
  isPrivate: false,
  body: 'we are looking into it',
  attachmentKind: null,
  playerMessageCount: 0,
  ...over,
});

const REAL_QUESTION = 'не пришёл депозит со вчера, что делать';

describe('the window closes at whichever comes first (FR-018)', () => {
  it('closes on the customer’s 3rd message, carrying the candidate chosen earlier', () => {
    const withCandidate: SubjectBefore = { ...OPEN, subject: 'не пришёл депозит' };
    expect(
      decideSubject(withCandidate, player({ body: 'алло', playerMessageCount: 3 })),
    ).toEqual({ subject: 'не пришёл депозит', subject_source: 'auto' });
  });

  it('does NOT close on the 2nd customer message', () => {
    const withCandidate: SubjectBefore = { ...OPEN, subject: 'не пришёл депозит' };
    expect(decideSubject(withCandidate, player({ body: 'алло', playerMessageCount: 2 }))).toBeNull();
  });

  it('closes on the first PUBLIC staff reply', () => {
    const withCandidate: SubjectBefore = { ...OPEN, subject: 'не пришёл депозит' };
    expect(decideSubject(withCandidate, staffReply())).toEqual({
      subject: 'не пришёл депозит',
      subject_source: 'auto',
    });
  });

  it('a PRIVATE note is inert — it is not a reply to the customer', () => {
    expect(decideSubject(OPEN, staffReply({ isPrivate: true }))).toBeNull();
  });

  it('a SYSTEM entry is inert', () => {
    expect(decideSubject(OPEN, { ...staffReply(), authorType: 'system' })).toBeNull();
  });

  it('pins the closing count, so changing it is a visible act', () => {
    expect(CLOSING_PLAYER_MESSAGE_COUNT).toBe(3);
  });
});

describe('the freeze (FR-018 / FR-022) — closed is closed', () => {
  it.each(['auto', 'manual'])('refuses every automated writer once source is %s', (source) => {
    const frozen: SubjectBefore = { subject: 'a real title', subject_source: source, category: null };
    expect(decideSubject(frozen, player({ body: REAL_QUESTION }))).toBeNull();
    expect(decideSubject(frozen, player({ body: REAL_QUESTION, playerMessageCount: 3 }))).toBeNull();
    expect(decideSubject(frozen, staffReply())).toBeNull();
  });

  it('the freeze is checked BEFORE anything else — a manual title survives a closing message', () => {
    const manual: SubjectBefore = {
      subject: 'выплата задерживается',
      subject_source: 'manual',
      category: 'payments',
    };
    expect(decideSubject(manual, player({ body: REAL_QUESTION, playerMessageCount: 9 }))).toBeNull();
  });
});

describe('choosing the candidate — first substantive message wins', () => {
  it('takes the first substantive customer message', () => {
    expect(decideSubject(OPEN, player({ body: REAL_QUESTION }))).toEqual({
      subject: REAL_QUESTION,
    });
  });

  it('skips a greeting and waits', () => {
    expect(decideSubject(OPEN, player({ body: 'привет' }))).toBeNull();
  });

  it('does not replace a candidate already chosen', () => {
    const chosen: SubjectBefore = { ...OPEN, subject: 'первый вопрос' };
    expect(decideSubject(chosen, player({ body: REAL_QUESTION, playerMessageCount: 2 }))).toBeNull();
  });

  it('sets the source only when the window closes, never when a candidate is chosen', () => {
    const change = decideSubject(OPEN, player({ body: REAL_QUESTION }));
    expect(change).not.toBeNull();
    expect(change).not.toHaveProperty('subject_source');
  });
});

describe('the attachment-only opener (FR-017)', () => {
  it('yields kind + topic and never a file name', () => {
    const withTopic: SubjectBefore = { ...OPEN, category: 'payments' };
    expect(decideSubject(withTopic, player({ body: '', attachmentKind: 'image' }))).toEqual({
      subject: 'image · payments',
    });
  });

  it('yields the bare kind when there is no topic yet', () => {
    expect(decideSubject(OPEN, player({ body: '', attachmentKind: 'image' }))).toEqual({
      subject: 'image',
    });
  });

  it('a screenshot WITH a real question keeps the question — the words beat the kind', () => {
    expect(
      decideSubject(OPEN, player({ body: REAL_QUESTION, attachmentKind: 'image' })),
    ).toEqual({ subject: REAL_QUESTION });
  });

  it('maps content types coarsely, and anything unknown is "file"', () => {
    expect(attachmentKindOf('image/png')).toBe('image');
    expect(attachmentKindOf('video/mp4')).toBe('video');
    expect(attachmentKindOf('audio/ogg')).toBe('audio');
    expect(attachmentKindOf('application/pdf')).toBe('document');
    expect(attachmentKindOf('text/plain')).toBe('document');
    expect(attachmentKindOf('application/vnd.ms-excel')).toBe('document');
    expect(attachmentKindOf('application/octet-stream')).toBe('file');
    expect(attachmentKindOf(null)).toBe('file');
    expect(attachmentKindOf(undefined)).toBe('file');
  });

  it('the composed title carries no file name', () => {
    expect(attachmentTitle('image', 'payments')).not.toMatch(/\.(png|jpe?g|pdf)\b/i);
    expect(attachmentTitle('image', null)).toBe('image');
  });
});

describe('truncation cuts at a word boundary (FR-019)', () => {
  it('leaves a short title untouched and collapses whitespace', () => {
    expect(toTitle('  не  пришёл\nдепозит  ')).toBe('не пришёл депозит');
  });

  it('a 4 000-character opener is cut at a space, never mid-word', () => {
    const long = 'депозит '.repeat(500).trim();
    const title = toTitle(long);
    expect(title.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    expect(title.endsWith('депозит')).toBe(true);
    expect(title).not.toMatch(/\s$/);
  });

  it('cuts hard when a single token is longer than the cap — there is no boundary to find', () => {
    const url = 'https://example.test/' + 'a'.repeat(300);
    const title = toTitle(url);
    expect(title.length).toBe(MAX_SUBJECT_LENGTH);
  });

  it('a long substantive opener is truncated on the way into the decision', () => {
    const long = 'не пришёл депозит и я очень жду ответа '.repeat(20).trim();
    const change = decideSubject(OPEN, player({ body: long }));
    expect(change?.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
  });
});

describe('the fallback close (FR-019) — never a fragment, never garbage', () => {
  it('stores the TOPIC when one is known', () => {
    const withTopic: SubjectBefore = { ...OPEN, category: 'payments' };
    expect(decideSubject(withTopic, player({ body: '???', playerMessageCount: 3 }))).toEqual({
      subject: 'payments',
      subject_source: 'auto',
    });
  });

  it('stores NULL when there is no topic — the dash is a RENDERING rule, not a stored value', () => {
    // ADR 0044 makes `—` "a single canonical token in the design system". Storing the glyph would put
    // a rendering decision in the database and make it sortable as if it were content.
    expect(decideSubject(OPEN, player({ body: 'привет', playerMessageCount: 3 }))).toEqual({
      subject: null,
      subject_source: 'auto',
    });
  });

  it('closes even with nothing usable, so the window never re-opens', () => {
    const change = decideSubject(OPEN, staffReply());
    expect(change).toEqual({ subject: null, subject_source: 'auto' });
  });

  it('never stores a non-substantive fragment as the title', () => {
    for (const noise of ['???', '🙂', 'hi', '   ']) {
      const change = decideSubject(OPEN, player({ body: noise, playerMessageCount: 3 }));
      expect(change?.subject).toBeNull();
    }
  });
});
