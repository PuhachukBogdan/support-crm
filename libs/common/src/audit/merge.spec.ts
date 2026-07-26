import {
  AuditCursorError,
  decodeComposite,
  decodeEntryCursor,
  encodeComposite,
  encodeEntryCursor,
  mergePages,
  type MergeableEntry,
  type SourceResult,
} from './merge';

/**
 * T020 (feature 015, US1) — the federated read's merge + cursor. FAILS before the module exists.
 *
 * The property worth the most here is not "the order is right" — it is that **a source resumes after the
 * last row that made it into the PAGE, not after the last row it handed us**. If auth contributes 10 rows
 * and only 3 fit, the other 7 must be re-offered next time. Getting that wrong silently drops entries, and
 * a gap in an audit log is the worst kind of bug: nobody can see it, and the log still looks complete.
 */
const e = (source: string, id: string, createdAt: string): MergeableEntry => ({ id, createdAt, source });

const src = (
  source: string,
  entries: MergeableEntry[],
  nextPageToken = '',
): SourceResult<MergeableEntry> => ({ source, entries, nextPageToken });

describe('encode/decode a per-source cursor', () => {
  it('round-trips', () => {
    const c = { createdAt: '2026-07-27T10:00:00.000Z', id: 'abc' };
    expect(decodeEntryCursor(encodeEntryCursor(c))).toEqual(c);
  });

  it('an empty token means the first page', () => {
    expect(decodeEntryCursor('')).toBeNull();
    expect(decodeEntryCursor(undefined)).toBeNull();
  });

  it.each(['not-base64!!', 'eyJhIjoxfQ', Buffer.from('["only-one"]').toString('base64url')])(
    'refuses the malformed token %p rather than scanning from the top',
    (token) => {
      expect(() => decodeEntryCursor(token)).toThrow(AuditCursorError);
    },
  );
});

describe('encode/decode a composite cursor', () => {
  it('round-trips a per-source map', () => {
    const c = { auth: 'tok-a', chats: 'tok-c' };
    expect(decodeComposite(encodeComposite(c))).toEqual(c);
  });

  it('an empty token means "query every source from the top"', () => {
    expect(decodeComposite('')).toEqual({});
    expect(decodeComposite(undefined)).toEqual({});
  });

  // Silently restarting would hand the reader page 1 while they believed they were on page 4 — and the
  // repeated entries would look like real duplicate entries in the trail.
  it.each([
    'nonsense',
    Buffer.from('["array","not","object"]').toString('base64url'),
    Buffer.from('{"auth":123}').toString('base64url'),
  ])('refuses the malformed composite token %p', (token) => {
    expect(() => decodeComposite(token)).toThrow(AuditCursorError);
  });
});

describe('mergePages — ordering', () => {
  it('interleaves sources into one newest-first page', () => {
    const page = mergePages(
      [
        src('auth', [e('auth', 'a2', '2026-07-27T12:00:00Z'), e('auth', 'a1', '2026-07-27T09:00:00Z')]),
        src('chats', [e('chats', 'c1', '2026-07-27T11:00:00Z')]),
      ],
      10,
    );
    expect(page.entries.map((x) => x.id)).toEqual(['a2', 'c1', 'a1']);
  });

  it('breaks ties in the same instant deterministically by id DESC', () => {
    const at = '2026-07-27T12:00:00Z';
    const page = mergePages(
      [src('auth', [e('auth', 'aaa', at)]), src('chats', [e('chats', 'zzz', at)])],
      10,
    );
    expect(page.entries.map((x) => x.id)).toEqual(['zzz', 'aaa']);
    // …and the same input in the other order yields the same output.
    const again = mergePages(
      [src('chats', [e('chats', 'zzz', at)]), src('auth', [e('auth', 'aaa', at)])],
      10,
    );
    expect(again.entries.map((x) => x.id)).toEqual(['zzz', 'aaa']);
  });

  it('respects the page size', () => {
    const page = mergePages(
      [
        src(
          'auth',
          ['05', '04', '03', '02', '01'].map((n) => e('auth', `a${n}`, `2026-07-27T${n}:00:00Z`)),
          'more',
        ),
      ],
      3,
    );
    expect(page.entries.map((x) => x.id)).toEqual(['a05', 'a04', 'a03']);
  });

  it('handles an empty fan-out', () => {
    expect(mergePages([], 10)).toEqual({ entries: [], nextPageToken: '' });
    expect(mergePages([src('auth', []), src('chats', [])], 10)).toEqual({
      entries: [],
      nextPageToken: '',
    });
  });
});

describe('mergePages — *** a source resumes after what was CONSUMED, not what it offered ***', () => {
  it('advances a partially-consumed source to its last consumed row', () => {
    const auth = src('auth', [
      e('auth', 'a3', '2026-07-27T13:00:00Z'),
      e('auth', 'a2', '2026-07-27T12:00:00Z'),
      e('auth', 'a1', '2026-07-27T11:00:00Z'),
    ]);
    const page = mergePages([auth], 2, {});
    expect(page.entries.map((x) => x.id)).toEqual(['a3', 'a2']);

    // The cursor must point at a2 — the last row that MADE THE PAGE — so a1 is re-offered next time.
    const next = decodeComposite(page.nextPageToken);
    expect(decodeEntryCursor(next.auth)).toEqual({ createdAt: '2026-07-27T12:00:00Z', id: 'a2' });
  });

  it('leaves a source that contributed NOTHING at its previous position', () => {
    const incoming = { chats: 'chats-previous-token' };
    const page = mergePages(
      [
        src('auth', [e('auth', 'a1', '2026-07-27T13:00:00Z')]),
        // Older rows: none of them fit in a 1-row page.
        src('chats', [e('chats', 'c1', '2026-07-27T01:00:00Z')], 'chats-more'),
      ],
      1,
      incoming,
    );
    expect(page.entries.map((x) => x.id)).toEqual(['a1']);
    const next = decodeComposite(page.nextPageToken);
    // chats must be asked again from exactly where it was — otherwise c1 disappears from the log.
    expect(next.chats).toBe('chats-previous-token');
  });

  it('drops an exhausted source out of the cursor entirely', () => {
    const page = mergePages(
      [
        src('auth', [e('auth', 'a1', '2026-07-27T13:00:00Z')], 'auth-more'),
        src('chats', [], ''), // nothing, and nothing more
      ],
      10,
    );
    const next = decodeComposite(page.nextPageToken);
    expect(Object.keys(next)).toEqual(['auth']);
  });

  it('no entry is lost across successive pages (the gap assertion)', () => {
    const all = [
      e('auth', 'a3', '2026-07-27T13:00:00Z'),
      e('chats', 'c2', '2026-07-27T12:30:00Z'),
      e('auth', 'a2', '2026-07-27T12:00:00Z'),
      e('chats', 'c1', '2026-07-27T11:00:00Z'),
      e('auth', 'a1', '2026-07-27T10:00:00Z'),
    ];
    // Walk the log two at a time, simulating each source honouring its own cursor.
    const seen: string[] = [];
    let cursor = {} as Record<string, string>;
    for (let guard = 0; guard < 10; guard += 1) {
      const results = ['auth', 'chats'].map((source) => {
        const from = cursor[source] === undefined ? null : decodeEntryCursor(cursor[source]);
        const remaining = all
          .filter((x) => x.source === source)
          .filter((x) => !from || x.createdAt < from.createdAt || (x.createdAt === from.createdAt && x.id < from.id));
        return src(source, remaining.slice(0, 2), remaining.length > 2 ? 'more' : '');
      });
      const page = mergePages(results, 2, cursor);
      seen.push(...page.entries.map((x) => x.id));
      if (!page.nextPageToken) break;
      cursor = decodeComposite(page.nextPageToken);
    }
    // Every entry exactly once, in global order.
    expect(seen).toEqual(['a3', 'c2', 'a2', 'c1', 'a1']);
  });
});

describe('mergePages — the end of the log', () => {
  it('returns no token when every source is exhausted', () => {
    const page = mergePages(
      [src('auth', [e('auth', 'a1', '2026-07-27T13:00:00Z')], ''), src('chats', [], '')],
      10,
    );
    expect(page.entries).toHaveLength(1);
    expect(page.nextPageToken).toBe('');
  });

  it('returns a token while any source still has rows buffered or pending', () => {
    const page = mergePages([src('auth', [e('auth', 'a1', '2026-07-27T13:00:00Z')], 'more')], 10);
    expect(page.nextPageToken).not.toBe('');
  });
});
