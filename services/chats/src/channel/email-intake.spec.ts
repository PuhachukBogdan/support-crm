import { Logger } from '@nestjs/common';
import { ChannelIntakeService } from './intake.service';
import type { ChannelRow } from './channel.repository';
import { fakeRealtime } from '../realtime/realtime.fake';

/**
 * T034/T036/T037/T039 (feature 033, US2) — **an email becomes a ticket, and its replies stay in it.**
 * FAILS before `intake.service.ts` grows `acceptInboundEmail`, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * The four properties asserted here, and why each one is worth a test:
 *
 *  1. **The Subject is the title, verbatim and frozen** (FR-028). Feature 023 exists because their live
 *     lists read "привет" and "???"; an email already carries the customer's own summary, and our
 *     derivation overwriting it would be a regression dressed as a feature.
 *  2. **At-most-once by `Message-ID`** (FR-032). An IMAP reconnect re-reads its batch BY DESIGN, so
 *     duplicate delivery is the normal case rather than the exceptional one.
 *  3. **The terminal-category rule** (FR-029). A solved ticket comes back; a closed one spawns a linked
 *     follow-up and is left alone.
 *  4. **Every refusal happens before the claim.** A claim followed by a refusal answers every later retry
 *     with "duplicate", so the customer's message is lost while the provider is satisfied.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

const CHANNEL: ChannelRow = {
  id: 'ch-mail',
  account_id: 'acc-1',
  brand_id: 'brand-1',
  kind: 'email',
  key: 'mail-key',
  address: 'support@brand.test',
  // W5: pushes to a desk — the enqueue-on-create leg is asserted in its own describe below.
  default_group_id: 'desk-a',
};

interface Written {
  conversations: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  statusSets: Array<{ id: string; status: string }>;
  audits: Array<Record<string, unknown>>;
  claims: string[];
  refusals: string[];
  released: string[];
}

function harness(
  opts: {
    channel?: ChannelRow | null;
    /** What the thread resolver finds, if anything. */
    match?: { conversationId: string; status: string } | null;
    /** The category `resolveActive` reports for the matched ticket's status. */
    category?: string | null;
    statusKeys?: Record<string, string | null>;
    /** Event ids already accepted — a second delivery of one of these is a duplicate. */
    alreadyAccepted?: string[];
    identityDown?: boolean;
    postThrows?: boolean;
  } = {},
) {
  const written: Written = {
    conversations: [],
    messages: [],
    statusSets: [],
    audits: [],
    claims: [],
    refusals: [],
    released: [],
  };
  const accepted = new Set(opts.alreadyAccepted ?? []);

  const channels = {
    resolveByKey: async (key: string) =>
      opts.channel === undefined ? (key === CHANNEL.key ? CHANNEL : null) : opts.channel,
  } as unknown as import('./channel.repository').ChannelRepository;

  const ledger = {
    claim: async (input: { externalEventId: string }) => {
      if (accepted.has(input.externalEventId)) {
        return { fresh: false, intakeId: 'i-old', conversationId: 'conv-first', messageId: 'msg-first' };
      }
      accepted.add(input.externalEventId);
      written.claims.push(input.externalEventId);
      return { fresh: true, intakeId: `i-${written.claims.length}` };
    },
    recordRefusal: async (input: { refusal: string }) => {
      written.refusals.push(input.refusal);
    },
    stampProduced: async () => undefined,
    release: async (_a: string, id: string) => {
      written.released.push(id);
    },
  } as unknown as import('./intake.ledger').IntakeLedger;

  const conversations = {
    create: async (accountId: string, input: Record<string, unknown>) => {
      const row = { id: `conv-${written.conversations.length + 1}`, account_id: accountId, ...input };
      written.conversations.push(row);
      return row;
    },
    setStatus: async (_a: string, id: string, status: string) => {
      written.statusSets.push({ id, status });
      return { id };
    },
  } as unknown as import('../conversation/conversation.repository').ConversationRepository;

  const messages = {
    post: async (accountId: string, input: Record<string, unknown>) => {
      if (opts.postThrows) throw new Error('the database blinked');
      const row = { id: `msg-${written.messages.length + 1}`, account_id: accountId, ...input };
      written.messages.push(row);
      return row;
    },
  } as unknown as import('../message/message.repository').MessageRepository;

  const statuses = {
    defaultKeyOfCategory: async (_a: string, category: string) => {
      const map = opts.statusKeys ?? { new: 'new', open: 'open' };
      return category in map ? map[category] : null;
    },
    resolveActive: async () =>
      opts.category === undefined || opts.category === null ? null : { category: opts.category },
  } as unknown as import('../status/status.repository').StatusRepository;

  const threads = {
    resolve: async () => opts.match ?? null,
  } as unknown as import('./threading').ThreadResolver;

  const participants = {
    resolve: async () => {
      if (opts.identityDown) throw new Error('users unreachable');
      return { participantId: 'part-1', playerId: '', ambiguous: false };
    },
  } as unknown as import('./participant.client').ChannelParticipantClient;

  const audit = {
    append: async (_a: string, entry: Record<string, unknown>) => {
      written.audits.push(entry);
    },
  } as unknown as import('../audit/audit.repository').AuditRepository;

  // W5: recording doubles for the routing leg — what reached the queue, and which events fired.
  const enqueued: Array<{ accountId: string; conversationId: string; groupId?: string }> = [];
  const backlog = {
    enqueue: async (accountId: string, conversationId: string, _at: Date, groupId?: string) => {
      enqueued.push({ accountId, conversationId, groupId });
    },
  } as unknown as import('../assignment/backlog').BacklogRepository;
  const events: Array<{ kind: string; conversationId: string }> = [];
  const domainEvents = {
    conversationCreated: async (_a: string, conversationId: string) => {
      events.push({ kind: 'conversation_created', conversationId });
      return 0;
    },
    messageReceived: async (_a: string, conversationId: string) => {
      events.push({ kind: 'message_received', conversationId });
      return 0;
    },
  } as unknown as import('../events/events.publisher').DomainEventPublisher;

  const service = new ChannelIntakeService(
    { secrets: new Map(), replayWindowSeconds: 300 } as never,
    channels,
    ledger,
    {} as never,
    conversations,
    messages,
    statuses,
    threads,
    participants,
    audit,
    fakeRealtime().publisher,
    backlog,
    domainEvents,
  );
  return { service, written, enqueued, events };
}

const mail = (over: Partial<Parameters<ChannelIntakeService['acceptInboundEmail']>[0]> = {}) => ({
  channelKey: CHANNEL.key,
  messageId: '<player-1@mail.test>',
  fromAddress: 'Player@Mail.TEST',
  subject: 'Не пришёл вывод #4471',
  bodyText: 'уже третий день',
  uploadIds: [],
  ...over,
});

describe('the happy path and the subject rules (FR-028)', () => {
  it('one email becomes one ticket whose title is the Subject header, frozen at creation', async () => {
    const { service, written } = harness();
    const out = await service.acceptInboundEmail(mail());

    expect(out).toEqual({ conversationId: 'conv-1', messageId: 'msg-1', duplicate: false });
    expect(written.conversations).toHaveLength(1);
    expect(written.conversations[0]).toMatchObject({
      brandId: 'brand-1',
      channel: 'email',
      status: 'new',
      subject: 'Не пришёл вывод #4471',
      // ⚠️ `'source'` and not `'auto'`: `auto` claims WE derived it, which would be false and would make
      // any later "title generated automatically" screen wrong about every email in the system.
      subjectSource: 'source',
      identityState: 'unidentified',
      channelParticipantId: 'part-1',
    });
    // The identifier a reply weeks later will quote. Without it, threading cannot be done retroactively.
    expect(written.messages[0]).toMatchObject({
      authorType: 'player',
      authorId: null,
      externalId: '<player-1@mail.test>',
      body: 'уже третий день',
    });
  });

  it('an EMPTY subject leaves our derivation window open rather than storing a blank title', async () => {
    const { service, written } = harness();
    await service.acceptInboundEmail(mail({ subject: '   ' }));
    // Both absent, together: a title with no source would leave the window open OVER it, and closing
    // that window would replace the customer's own words with our summary of them.
    expect(written.conversations[0]!.subject).toBeUndefined();
    expect(written.conversations[0]!.subjectSource).toBeUndefined();
  });

  it('a subject-only email is still a ticket; a message with nothing at all is refused', async () => {
    // Weaker than the API channel's "a body is required", deliberately: an email whose Subject is the
    // whole question is an ordinary support request. Refusing it would lose real customers to formatting.
    const one = harness();
    await one.service.acceptInboundEmail(mail({ bodyText: '' }));
    expect(one.written.conversations).toHaveLength(1);

    const none = harness();
    const out = await none.service.acceptInboundEmail(mail({ bodyText: '', subject: '' }));
    expect(out.refusal).toBe('incomplete');
    expect(none.written.conversations).toHaveLength(0);
  });
});

describe('at-most-once, including the reconnect case (FR-032/FR-027c)', () => {
  it('the same Message-ID ten times → one ticket, and nine answers of "duplicate"', async () => {
    const { service, written } = harness();
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(await service.acceptInboundEmail(mail()));

    expect(written.conversations).toHaveLength(1);
    expect(written.messages).toHaveLength(1);
    expect(outcomes.filter((o) => o.duplicate)).toHaveLength(9);
    // ⚠️ A duplicate answers with what the FIRST acceptance produced, not with empty ids: a reader of the
    // response must be able to point at the ticket either way.
    expect(outcomes[9]).toEqual({ conversationId: 'conv-first', messageId: 'msg-first', duplicate: true });
  });

  it('a reconnect re-reading its whole batch adds nothing', async () => {
    // The mechanism most likely to double-deliver, and the reason the Redis lease is documented as an
    // efficiency device rather than the correctness one: THIS constraint is the correctness device.
    const batch = ['<a@mail.test>', '<b@mail.test>', '<c@mail.test>'];
    const { service, written } = harness();
    for (const id of batch) await service.acceptInboundEmail(mail({ messageId: id }));
    for (const id of batch) await service.acceptInboundEmail(mail({ messageId: id }));

    expect(written.conversations).toHaveLength(3);
    expect(written.messages).toHaveLength(3);
  });

  it('a message with no Message-ID is REFUSED, never accepted with a generated one', async () => {
    const { service, written } = harness();
    const out = await service.acceptInboundEmail(mail({ messageId: '  ' }));
    expect(out.refusal).toBe('no_event_id');
    expect(written.claims).toHaveLength(0);
    expect(written.refusals).toEqual(['no_event_id']);
  });
});

describe('the terminal-category rule (FR-029a/FR-029b)', () => {
  it('solved → reopened into the account’s own open status, with the reopen audited', async () => {
    const { service, written } = harness({
      match: { conversationId: 'conv-solved', status: 'solved_ru' },
      category: 'solved',
      statusKeys: { new: 'new', open: 'in_progress' },
    });
    const out = await service.acceptInboundEmail(mail());

    expect(out.conversationId).toBe('conv-solved');
    // The KEY comes from the catalogue, never the literal `'open'`.
    expect(written.statusSets).toEqual([{ id: 'conv-solved', status: 'in_progress' }]);
    // ⚠️ Audited as well as transitioned: this is a state change NOBODY AUTHORISED, and a ticket that
    // reopens itself with no accountability record is a closed-work number that changes with nothing to
    // point at. The detail carries the channel KIND and no customer data.
    //
    // Selected by ACTION rather than by position: US3 added a second entry on this path (the identity
    // resolution), and an index would have made this assertion depend on which was written first.
    const reopened = written.audits.filter((a) => a.action === 'conversation.reopened_by_reply');
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({
      action: 'conversation.reopened_by_reply',
      actorKind: 'system',
      targetRef: 'conversation:conv-solved',
      detail: { channelKind: 'email' },
    });
    expect(written.conversations).toHaveLength(0);
  });

  it('closed → left untouched; a NEW ticket carries the link to what it continues', async () => {
    const { service, written } = harness({
      match: { conversationId: 'conv-closed', status: 'archived' },
      category: 'closed',
    });
    const out = await service.acceptInboundEmail(mail());

    expect(written.statusSets).toHaveLength(0);
    // Creating a ticket needs no accountability record — the LINK on the row is the record. The identity
    // entry US3 writes is a different fact and is asserted in `identity-event.spec.ts`.
    expect(written.audits.filter((a) => a.action === 'conversation.reopened_by_reply')).toHaveLength(0);
    expect(written.conversations[0]).toMatchObject({
      continuesConversationId: 'conv-closed',
      status: 'new',
    });
    expect(out.conversationId).toBe('conv-1');
  });

  it('a live thread just gains a message — no status write, no new ticket', async () => {
    const { service, written } = harness({
      match: { conversationId: 'conv-live', status: 'pending_customer' },
      category: 'pending',
    });
    const out = await service.acceptInboundEmail(mail());
    expect(out.conversationId).toBe('conv-live');
    expect(written.conversations).toHaveLength(0);
    expect(written.statusSets).toHaveLength(0);
    expect(written.messages[0]).toMatchObject({ conversationId: 'conv-live' });
  });
});

describe('every refusal happens BEFORE the claim, so a retry is still possible', () => {
  it('an unknown or disabled channel writes nothing at all', async () => {
    const { service, written } = harness({ channel: null });
    const out = await service.acceptInboundEmail(mail());
    expect(out.refusal).toBe('unknown_channel');
    // Not even a refusal row: there is no account to record it against, and inventing one would put a
    // row in some tenant's ledger for a delivery that named no tenant.
    expect(written.refusals).toHaveLength(0);
    expect(written.claims).toHaveLength(0);
  });

  it('a key naming an API channel is refused rather than stamped as email', async () => {
    const { service, written } = harness({ channel: { ...CHANNEL, kind: 'api' } });
    const out = await service.acceptInboundEmail(mail());
    expect(out.refusal).toBe('channel_kind_mismatch');
    expect(written.claims).toHaveLength(0);
  });

  it('an UNREACHABLE users refuses and claims nothing — the mail stays in the mailbox', async () => {
    // ⚠️ The distinction this asserts: "users found nobody" is an ordinary unidentified ticket, and
    // "users cannot be asked" must not become one. Accepting would create a ticket with no envelope —
    // one an agent can read and cannot answer, with nothing on screen saying why.
    const { service, written } = harness({ identityDown: true });
    const out = await service.acceptInboundEmail(mail());
    expect(out.refusal).toBe('identity_unavailable');
    expect(written.claims).toHaveLength(0);
    expect(written.conversations).toHaveLength(0);
  });

  it('an account with no status in the needed category is refused loudly, before claiming', async () => {
    const { service, written } = harness({ statusKeys: {} });
    const out = await service.acceptInboundEmail(mail());
    expect(out.refusal).toBe('no_status_configured');
    expect(written.claims).toHaveLength(0);
  });

  it('a write that THROWS after the claim gives the claim back', async () => {
    // ⭐ Without this, a database that blinked between the claim and the write would leave a ledger row
    // saying "accepted" with no ticket behind it — and every retry answered "duplicate" for ever. The
    // delivery would be gone, the provider satisfied, and nothing anywhere red.
    const { service, written } = harness({ postThrows: true });
    await expect(service.acceptInboundEmail(mail())).rejects.toThrow();
    expect(written.claims).toEqual(['<player-1@mail.test>']);
    expect(written.released).toEqual(['i-1']);
  });
});

describe('no contact value reaches the log (FR-047)', () => {
  it('logs the kind, the account and the conversation — never the address, subject or body', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const ok = harness();
      await ok.service.acceptInboundEmail(mail());
      const down = harness({ identityDown: true });
      await down.service.acceptInboundEmail(mail());
      const bad = harness({ channel: null });
      await bad.service.acceptInboundEmail(mail());

      // ⚠️ Asserted FIRST. A scan over an empty array reports success — the vacuous pass this project has
      // shipped three times — so the test proves it has something to scan before it scans it.
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const secret of [
        'player@mail.test',
        'Player@Mail.TEST',
        'Не пришёл вывод',
        'уже третий день',
      ]) {
        expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
      }
      expect(all).toContain('kind=email');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

/**
 * ── W5 (subpoint 2.4): only a ticket that CAME INTO EXISTENCE is pushed to the desk ──────────────
 *
 * An append lands in a conversation that has its owner (or already waits); a reopen returns to
 * whoever worked it. Re-queueing either would tear work out of its history — so the enqueue and the
 * `conversation_created` event ride the same `created` bit, and these two tests pin them together.
 */
describe('W5: the mail path routes NEW tickets and leaves lived-in ones alone', () => {
  it('a new ticket is enqueued with the desk AND fires both events', async () => {
    const { service, written, enqueued, events } = harness();
    await service.acceptInboundEmail(mail());
    const conversationId = (written.conversations[0] as { id?: string }).id ?? 'conv-1';
    expect(enqueued).toEqual([
      { accountId: CHANNEL.account_id, conversationId, groupId: 'desk-a' },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['conversation_created', 'message_received']);
  });

  it('an APPEND enqueues nothing and fires message_received only', async () => {
    const { service, enqueued, events } = harness({
      match: { conversationId: 'conv-live', status: 'pending_customer' },
      category: 'pending',
    });
    await service.acceptInboundEmail(mail());
    expect(enqueued).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(['message_received']);
  });
});
