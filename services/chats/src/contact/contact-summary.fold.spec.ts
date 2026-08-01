import { foldContactSummary, type ContactGroupRow } from './contact-summary.fold';

/**
 * Feature 022 (roadmap 4.13), T019/T029 — **the fold: grouped rows → what the card shows.**
 *
 * The read is ONE `groupBy(['channel','status'])` with `_count` and `_max` over the two maintained
 * columns (research R4). Everything the card needs is then arithmetic on that one result set, which is
 * why FR-010's "the per-channel counts sum to the total" is an identity here rather than an agreement
 * between two queries that can disagree.
 *
 * Pure, so every case below is a data case — no database, no fake, nothing to mistake for the
 * behaviour of a mock.
 */
function row(over: Partial<ContactGroupRow> = {}): ContactGroupRow {
  return {
    channel: 'email',
    status: 'open',
    conversationCount: 1,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...over,
  };
}

const at = (iso: string) => new Date(iso);

describe('foldContactSummary — the overall facts', () => {
  it('an empty result set is the NEVER CONTACTED answer, not an error and not a blank', () => {
    const s = foldContactSummary([]);
    expect(s).toEqual({
      lastInboundAt: null,
      lastOutboundAt: null,
      lastContactAt: null,
      conversationCount: 0,
      countsByStatus: [],
      channels: [],
    });
  });

  it('takes the maximum of each column across every group', () => {
    const s = foldContactSummary([
      row({ channel: 'email', lastInboundAt: at('2026-07-20T09:00:00Z') }),
      row({ channel: 'api', lastInboundAt: at('2026-07-22T09:00:00Z') }),
      row({ channel: 'api', status: 'pending', lastOutboundAt: at('2026-07-21T09:00:00Z') }),
    ]);
    expect(s.lastInboundAt).toEqual(at('2026-07-22T09:00:00Z'));
    expect(s.lastOutboundAt).toEqual(at('2026-07-21T09:00:00Z'));
  });

  it('derives lastContactAt as the LATER of the two, and says so by being derived', () => {
    const later = foldContactSummary([
      row({ lastInboundAt: at('2026-07-22T09:00:00Z'), lastOutboundAt: at('2026-07-21T09:00:00Z') }),
    ]);
    expect(later.lastContactAt).toEqual(at('2026-07-22T09:00:00Z'));

    const earlier = foldContactSummary([
      row({ lastInboundAt: at('2026-07-20T09:00:00Z'), lastOutboundAt: at('2026-07-21T09:00:00Z') }),
    ]);
    expect(earlier.lastContactAt).toEqual(at('2026-07-21T09:00:00Z'));
  });

  it('derives lastContactAt from whichever side exists when only one does', () => {
    // "They wrote and nobody answered" and "we answered and they went quiet" are the two states the card
    // exists to distinguish (SC-001). Both must still produce a last-contact value.
    const inboundOnly = foldContactSummary([row({ lastInboundAt: at('2026-07-20T09:00:00Z') })]);
    expect(inboundOnly.lastContactAt).toEqual(at('2026-07-20T09:00:00Z'));
    expect(inboundOnly.lastOutboundAt).toBeNull();

    const outboundOnly = foldContactSummary([row({ lastOutboundAt: at('2026-07-20T09:00:00Z') })]);
    expect(outboundOnly.lastContactAt).toEqual(at('2026-07-20T09:00:00Z'));
    expect(outboundOnly.lastInboundAt).toBeNull();
  });

  it('leaves lastContactAt null when a conversation exists but nobody ever spoke', () => {
    // A conversation whose only message is a private note, or which has no messages at all. It is
    // COUNTED and contributes no timestamps — never an epoch date.
    const s = foldContactSummary([row({ conversationCount: 3 })]);
    expect(s.conversationCount).toBe(3);
    expect(s.lastContactAt).toBeNull();
  });

  it('sums the conversation count across every group', () => {
    const s = foldContactSummary([
      row({ channel: 'email', status: 'open', conversationCount: 2 }),
      row({ channel: 'email', status: 'resolved', conversationCount: 5 }),
      row({ channel: 'api', status: 'open', conversationCount: 1 }),
    ]);
    expect(s.conversationCount).toBe(8);
  });
});

describe('foldContactSummary — counts by status (research R9, not a single "open" number)', () => {
  it('collapses the status dimension across channels', () => {
    const s = foldContactSummary([
      row({ channel: 'email', status: 'open', conversationCount: 2 }),
      row({ channel: 'api', status: 'open', conversationCount: 3 }),
      row({ channel: 'api', status: 'pending', conversationCount: 1 }),
    ]);
    expect(s.countsByStatus).toEqual([
      { status: 'open', conversationCount: 5 },
      { status: 'pending', conversationCount: 1 },
    ]);
  });

  it('reports pending and snoozed as themselves — the reason there is no single "open count"', () => {
    // "Open" is ambiguous between `status = open` and "not resolved". Both readings are derivable from
    // this list; neither is silently chosen for the caller.
    const s = foldContactSummary([
      row({ status: 'open', conversationCount: 1 }),
      row({ status: 'pending', conversationCount: 2 }),
      row({ status: 'snoozed', conversationCount: 3 }),
      row({ status: 'resolved', conversationCount: 4 }),
    ]);
    expect(s.countsByStatus.map((c) => c.status)).toEqual(['open', 'pending', 'resolved', 'snoozed']);
    expect(s.countsByStatus.reduce((n, c) => n + c.conversationCount, 0)).toBe(10);
  });

  it('omits a status with no conversations rather than reporting a zero', () => {
    const s = foldContactSummary([row({ status: 'open', conversationCount: 1 })]);
    expect(s.countsByStatus).toEqual([{ status: 'open', conversationCount: 1 }]);
  });
});

describe('foldContactSummary — the channel rollup (FR-009/FR-010/FR-011)', () => {
  it('collapses the status dimension per channel, keeping each channel’s own maxima', () => {
    const s = foldContactSummary([
      row({ channel: 'whatsapp', status: 'open', lastInboundAt: at('2026-07-22T09:00:00Z') }),
      row({ channel: 'whatsapp', status: 'resolved', lastInboundAt: at('2026-07-20T09:00:00Z') }),
      row({ channel: 'email', status: 'open', lastOutboundAt: at('2026-07-21T09:00:00Z') }),
    ]);
    expect(s.channels).toEqual([
      {
        channel: 'email',
        channelUnrecorded: false,
        lastInboundAt: null,
        lastOutboundAt: at('2026-07-21T09:00:00Z'),
        conversationCount: 1,
      },
      {
        channel: 'whatsapp',
        channelUnrecorded: false,
        lastInboundAt: at('2026-07-22T09:00:00Z'),
        lastOutboundAt: null,
        conversationCount: 2,
      },
    ]);
  });

  it('"they write on WhatsApp, we answer by email" is visible per channel', () => {
    const s = foldContactSummary([
      row({ channel: 'whatsapp', lastInboundAt: at('2026-07-22T09:00:00Z') }),
      row({ channel: 'email', lastOutboundAt: at('2026-07-22T10:00:00Z') }),
    ]);
    const wa = s.channels.find((c) => c.channel === 'whatsapp')!;
    const email = s.channels.find((c) => c.channel === 'email')!;
    expect([wa.lastInboundAt, wa.lastOutboundAt]).toEqual([at('2026-07-22T09:00:00Z'), null]);
    expect([email.lastInboundAt, email.lastOutboundAt]).toEqual([null, at('2026-07-22T10:00:00Z')]);
  });

  it('a NULL channel becomes its own entry, flagged unrecorded, with an empty name', () => {
    // `Conversation.channel` is nullable and only the seed / API path writes it until Phase 6 — so this
    // is the state the ENTIRE existing history is in. A rollup that skipped the null group would
    // under-report exactly the conversations that exist today, and would look correct doing it.
    const s = foldContactSummary([
      row({ channel: null, conversationCount: 4, lastInboundAt: at('2026-07-22T09:00:00Z') }),
    ]);
    expect(s.channels).toEqual([
      {
        channel: '',
        channelUnrecorded: true,
        lastInboundAt: at('2026-07-22T09:00:00Z'),
        lastOutboundAt: null,
        conversationCount: 4,
      },
    ]);
  });

  it('THE IDENTITY: per-channel counts sum to the total, including the unrecorded group (FR-010)', () => {
    const rows = [
      row({ channel: 'email', status: 'open', conversationCount: 2 }),
      row({ channel: 'api', status: 'pending', conversationCount: 3 }),
      row({ channel: null, status: 'open', conversationCount: 5 }),
      row({ channel: null, status: 'resolved', conversationCount: 7 }),
    ];
    const s = foldContactSummary(rows);
    expect(s.channels.reduce((n, c) => n + c.conversationCount, 0)).toBe(s.conversationCount);
    expect(s.conversationCount).toBe(17);
    expect(s.channels).toHaveLength(3);
  });

  it('a channel literally named "unknown" is NOT the unrecorded bucket', () => {
    // The collision a sentinel string would cause, pinned so nobody "simplifies" the boolean away.
    const s = foldContactSummary([row({ channel: 'unknown', conversationCount: 1 })]);
    expect(s.channels).toEqual([
      {
        channel: 'unknown',
        channelUnrecorded: false,
        lastInboundAt: null,
        lastOutboundAt: null,
        conversationCount: 1,
      },
    ]);
  });

  it('an empty-string channel is reported as itself, distinct from unrecorded', () => {
    // The other half of the same collision: `''` is how a null channel renders elsewhere in the product,
    // which is precisely why the flag exists instead of a magic value.
    const s = foldContactSummary([
      row({ channel: '', conversationCount: 1 }),
      row({ channel: null, conversationCount: 2 }),
    ]);
    const unrecorded = s.channels.filter((c) => c.channelUnrecorded);
    expect(unrecorded).toHaveLength(1);
    expect(unrecorded[0]!.conversationCount).toBe(2);
    expect(s.channels).toHaveLength(2);
  });

  it('an unrecognised channel value is reported verbatim, never coerced (FR-011)', () => {
    const s = foldContactSummary([row({ channel: 'carrier-pigeon', conversationCount: 1 })]);
    expect(s.channels[0]!.channel).toBe('carrier-pigeon');
    expect(s.channels[0]!.channelUnrecorded).toBe(false);
  });

  it('orders channels deterministically, with the unrecorded group last', () => {
    // Not cosmetic: a card rendering a list needs a stable order, and "the ones we cannot name" belong at
    // the end rather than interleaved by whatever the planner returned.
    const s = foldContactSummary([
      row({ channel: 'whatsapp' }),
      row({ channel: null }),
      row({ channel: 'api' }),
      row({ channel: 'email' }),
    ]);
    expect(s.channels.map((c) => c.channel)).toEqual(['api', 'email', 'whatsapp', '']);
    expect(s.channels[3]!.channelUnrecorded).toBe(true);
  });
});
