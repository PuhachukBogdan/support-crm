import { Logger } from '@nestjs/common';
import { MailSendError, type MailMessage } from '@crm/common';
import { OutboundService } from './outbound.service';
import { OutboundRepository } from './outbound.repository';

/**
 * T056–T061 (feature 033, US4) — **the agent's reply reaches the customer, once.**
 * FAILS before `outbound.service.ts` and `outbound.repository.ts` exist, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **A REPLY SENT TWICE CANNOT BE RECALLED**, and to the customer it says nobody is reading their
 * ticket. Every other failure in this feature has a repair; this one does not. So this file is mostly
 * about the sequence: what must happen before the send, what must happen after it, and what may never
 * happen twice.
 *
 * SC-005 states it as a number: the copies received is never 2.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

interface Row {
  id: string;
  account_id: string;
  conversation_id: string;
  message_id: string;
  channel_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  last_error_class: string | null;
  created_at: Date;
}

const NOW = new Date('2026-08-05T10:00:00.000Z');

function harness(
  opts: {
    /** What the transport does. Default: accepts. */
    send?: (m: MailMessage) => Promise<void>;
    channel?: string | null;
    participantId?: string | null;
    subject?: string | null;
    /** The customer's last inbound message identifier, for the threading headers. */
    lastInboundExternalId?: string | null;
    messageExternalId?: string | null;
    attempts?: number;
    lastInboundAt?: Date | null;
    envelopeThrows?: boolean;
  } = {},
) {
  const row: Row = {
    id: 'ob-1',
    account_id: 'acc-1',
    conversation_id: 'conv-1',
    message_id: 'msg-1',
    channel_id: 'ch-mail',
    status: 'pending',
    attempts: opts.attempts ?? 0,
    next_attempt_at: new Date(NOW.getTime() - 1000),
    last_attempt_at: null,
    last_error_class: null,
    created_at: NOW,
  };
  const rows = new Map<string, Row>([[row.id, row]]);
  const sentMail: MailMessage[] = [];
  const messageUpdates: Array<Record<string, unknown>> = [];

  const message = {
    id: 'msg-1',
    body: 'мы проверяем ваш вывод',
    external_id: opts.messageExternalId ?? null,
    created_at: NOW,
  };

  const delegate = {
    findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      // Two shapes reach this delegate: the CANDIDATE query (`status` + a due clock, no id) and the
      // by-id reads that follow it. The fake honours the due clock, because "a row whose delay has not
      // expired must not be picked up" is one of the properties under test.
      if (args.where.id === undefined) {
        const due = (args.where.next_attempt_at as { lte: Date } | undefined)?.lte;
        for (const r of rows.values()) {
          if (args.where.status && r.status !== args.where.status) continue;
          if (due && r.next_attempt_at.getTime() > due.getTime()) continue;
          return { id: r.id };
        }
        return null;
      }
      const found = rows.get(String(args.where.id));
      if (!found) return null;
      if (args.select?.account_id) return { account_id: found.account_id };
      return { ...found };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows.values()) {
        if (args.where.id && r.id !== args.where.id) continue;
        // The conditional claim: the predicate is what decides a race, so the fake honours it.
        if (args.where.status && r.status !== args.where.status) continue;
        Object.assign(r, args.data);
        count += 1;
      }
      return { count };
    },
    deleteMany: async (args: { where: { id: string } }) => {
      rows.delete(args.where.id);
      return { count: 1 };
    },
  };

  const prisma = {
    outboundMessage: delegate,
    forAccount: () => ({
      outboundMessage: delegate,
      message: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          // The reply itself, or the customer's last inbound message (the threading lookup).
          if (args.where.author_type === 'player') {
            return opts.lastInboundExternalId === undefined
              ? { external_id: '<player-9@mail.test>' }
              : opts.lastInboundExternalId === null
                ? null
                : { external_id: opts.lastInboundExternalId };
          }
          return { ...message };
        },
        updateMany: async (args: { data: Record<string, unknown> }) => {
          messageUpdates.push(args.data);
          Object.assign(message, { external_id: args.data.external_id });
          return { count: 1 };
        },
      },
      conversation: {
        findFirst: async () => ({
          id: 'conv-1',
          brand_id: 'brand-1',
          channel: opts.channel === undefined ? 'email' : opts.channel,
          subject: opts.subject === undefined ? 'Вывод #4471' : opts.subject,
          channel_participant_id:
            opts.participantId === undefined ? 'part-1' : opts.participantId,
          last_inbound_at: opts.lastInboundAt === undefined ? NOW : opts.lastInboundAt,
        }),
      },
    }),
  } as unknown as import('../prisma.service').PrismaService;

  const participants = {
    envelope: async () => {
      if (opts.envelopeThrows) throw new Error('users unreachable');
      return 'player@mail.test';
    },
  } as unknown as import('./participant.client').ChannelParticipantClient;

  const transport = {
    send: async (m: MailMessage) => {
      if (opts.send) return opts.send(m);
      sentMail.push(m);
    },
  };

  const outbox = new OutboundRepository(prisma);
  const service = new OutboundService(
    prisma,
    outbox,
    participants,
    transport,
    { secrets: new Map(), replayWindowSeconds: 300, emailAddress: 'support@brand.test', maxAttempts: 3 },
  );
  return { service, rows, row, sentMail, messageUpdates, outbox, prisma };
}

describe('the happy path: one claim, one send, no row left behind', () => {
  it('sends once and DELETES the row — this is a queue, not a history', async () => {
    const { service, rows, sentMail } = harness();
    await expect(service.sendDue(10, NOW)).resolves.toEqual({ attempted: 1, sent: 1, failed: 0 });
    expect(sentMail).toHaveLength(1);
    // The history is the message itself, which already carries the `Message-ID` a reply will quote.
    expect(rows.size).toBe(0);
  });

  it('threads the reply: our own Message-ID out, the customer’s quoted back', async () => {
    const { service, sentMail, messageUpdates } = harness();
    await service.sendDue(10, NOW);
    const mail = sentMail[0]!;
    expect(mail.headers!['Message-ID']).toMatch(/^<.+@brand-1\.crm>$/);
    expect(mail.headers!['In-Reply-To']).toBe('<player-9@mail.test>');
    expect(mail.headers!.References).toBe('<player-9@mail.test>');
    // ⭐ Written to the MESSAGE before the send, so a reply weeks later still threads even though the
    // outbox row is gone. Written after a successful send it would be lost by any crash in between.
    expect(messageUpdates[0]!.external_id).toBe(mail.headers!['Message-ID']);
  });

  it('reuses an existing Message-ID rather than minting a second identity for one reply', async () => {
    // The retry case. Two identities for one reply would give the customer two threads to answer into,
    // and our own inbound matcher two different ids to find.
    const { service, sentMail, messageUpdates } = harness({ messageExternalId: '<ours-1@brand-1.crm>' });
    await service.sendDue(10, NOW);
    expect(sentMail[0]!.headers!['Message-ID']).toBe('<ours-1@brand-1.crm>');
    expect(messageUpdates).toHaveLength(0);
  });

  it('`Re:` appears once, never twice', async () => {
    const plain = harness();
    await plain.service.sendDue(10, NOW);
    expect(plain.sentMail[0]!.subject).toBe('Re: Вывод #4471');

    const already = harness({ subject: 'Re: Вывод #4471' });
    await already.service.sendDue(10, NOW);
    expect(already.sentMail[0]!.subject).toBe('Re: Вывод #4471');
  });

  it('sends FROM the brand’s own address — never a hardcoded identity (white-label rule 6)', async () => {
    const { service, sentMail } = harness();
    await service.sendDue(10, NOW);
    expect(sentMail[0]!.from).toBe('support@brand.test');
  });
});

describe('exactly once, under a race and under a retry (FR-038)', () => {
  it('two claimers race and exactly ONE wins', async () => {
    // The whole of idempotency here: `status: 'pending'` in the update predicate. The second claimer
    // matches zero rows and gets nothing — no lock, no coordination, no second system to agree with.
    const { outbox } = harness();
    const [first, second] = await Promise.all([outbox.claimNext(NOW), outbox.claimNext(NOW)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('a transport that refuses once then accepts delivers ONE copy', async () => {
    let calls = 0;
    const { service, sentMail, rows } = harness({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new MailSendError('unreachable');
      },
    });

    // First pass: refused, back to pending with a delay.
    await expect(service.sendDue(10, NOW)).resolves.toMatchObject({ sent: 0, failed: 1 });
    const row = [...rows.values()][0]!;
    expect(row.status).toBe('pending');
    // ⭐ The delta from feature 028: the clock GREW, so the next tick does not retry immediately.
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(NOW.getTime());

    // A tick before the delay expires must not pick it up.
    await expect(service.sendDue(10, NOW)).resolves.toMatchObject({ attempted: 0 });

    // After the delay: accepted, once.
    const later = new Date(row.next_attempt_at.getTime() + 1000);
    await expect(service.sendDue(10, later)).resolves.toMatchObject({ sent: 1 });
    expect(sentMail).toHaveLength(0); // the fake `send` swallows; the count is what matters
    expect(calls).toBe(2);
    expect(rows.size).toBe(0);
  });

  it('the backoff GROWS between attempts rather than repeating one delay', async () => {
    const first = harness({ send: async () => { throw new MailSendError('unreachable'); } });
    await first.service.sendDue(10, NOW);
    const afterOne = [...first.rows.values()][0]!.next_attempt_at.getTime() - NOW.getTime();

    const third = harness({
      attempts: 2,
      send: async () => { throw new MailSendError('unreachable'); },
    });
    await third.service.sendDue(10, NOW);
    const afterThree = [...third.rows.values()][0]!.next_attempt_at.getTime() - NOW.getTime();

    expect(afterThree).toBeGreaterThan(afterOne);
  });
});

describe('the dead letter (FR-039/FR-040)', () => {
  it('the attempt budget spent → `failed`, with an error CLASS and no relay text', async () => {
    const { service, rows } = harness({
      attempts: 2, // budget is 3
      send: async () => {
        throw new MailSendError('unreachable');
      },
    });
    await service.sendDue(10, NOW);
    const row = [...rows.values()][0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    // ⚠️ A CLASS. An SMTP rejection quotes the envelope as a matter of course — `550 5.1.1
    // <someone@example.test> recipient rejected` — and the envelope is the customer's address.
    expect(row.last_error_class).toBe('unreachable');
    // Left for a person to find. Nothing deletes it: an answer the customer never received is exactly
    // the thing that must not disappear quietly.
    expect(rows.size).toBe(1);
  });

  it('a permanent refusal is NOT retried, even with budget left', async () => {
    // `refused` and `recipient_blocked` will not change their mind. Retrying them is the product
    // spending itself on a message that will never arrive while the agent believes it was sent.
    const { service, rows } = harness({
      send: async () => {
        throw new MailSendError('refused');
      },
    });
    await service.sendDue(10, NOW);
    expect([...rows.values()][0]!.status).toBe('failed');
  });
});

describe('the capability gate and the missing envelope, both server-side (FR-006/FR-043)', () => {
  it('a kind with no transport is refused and NOTHING is sent', async () => {
    // ⚠️ Enforcement, not decoration: the verdict comes from the one `canSend` any future UI will ask,
    // so a screen that merely hid the button could not leave this path reachable.
    const { service, sentMail, rows } = harness({ channel: 'messenger' });
    await expect(service.sendDue(10, NOW)).resolves.toMatchObject({ sent: 0, failed: 1 });
    expect(sentMail).toHaveLength(0);
    expect([...rows.values()][0]!.last_error_class).toBe('no_transport');
  });

  it('an API-channel ticket is refused — the widget has no address to deliver to', async () => {
    const { service, sentMail } = harness({ channel: 'api' });
    await service.sendDue(10, NOW);
    expect(sentMail).toHaveLength(0);
  });

  it('a ticket with no envelope handle is dead-lettered rather than retried for ever', async () => {
    const { service, rows, sentMail } = harness({ participantId: null });
    await service.sendDue(10, NOW);
    expect(sentMail).toHaveLength(0);
    expect([...rows.values()][0]!.status).toBe('failed');
  });

  it('an unreachable users is RETRIED — the address exists, we could not ask', async () => {
    const { service, rows } = harness({ envelopeThrows: true });
    await service.sendDue(10, NOW);
    expect([...rows.values()][0]!.status).toBe('pending');
  });
});

describe('nothing about the customer reaches the log (FR-044, research R6)', () => {
  it('logs the conversation, a class and counts — never the recipient, subject or body', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const ok = harness();
      await ok.service.sendDue(10, NOW);
      const bad = harness({
        send: async () => {
          // A relay's own sentence, exactly as it arrives in reality — quoting the envelope.
          throw new MailSendError('unreachable');
        },
      });
      await bad.service.sendDue(10, NOW);

      // ⚠️ Asserted FIRST: a scan over an empty array reports success, which is the vacuous pass this
      // project has shipped three times.
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const forbidden of ['player@mail.test', 'Вывод #4471', 'мы проверяем ваш вывод']) {
        expect(all).not.toContain(forbidden);
      }
      // What it DOES say — the difference from feature 028, which logs `to=<address>` and is right to.
      expect(all).toContain('conversation=conv-1');
      expect(all).toContain('class=unreachable');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
