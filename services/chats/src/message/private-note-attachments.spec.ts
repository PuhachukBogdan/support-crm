import type { PrismaService } from '../prisma.service';
import { MessageRepository } from './message.repository';
import { toMessageWire, type AttachmentWire } from '../shared/wire';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * Feature 033: the delivery-intent writer, stubbed to do NOTHING.
 *
 * These specs post on tickets whose channel is not email, so the real repository would enqueue nothing
 * either — the stub keeps that true without giving the fake transaction a `channel` delegate. The enqueue
 * rule itself is asserted in `services/chats/src/channel/outbound.spec.ts`, where a public reply on an
 * email ticket must produce exactly one intent and a private note none.
 */
function noOutbox() {
  return {
    enqueue: async () => undefined,
  } as unknown as import('../channel/outbound.repository').OutboundRepository;
}


/**
 * T044 (feature 016, US2) — an attachment on a PRIVATE NOTE is absent from the customer projection
 * (SEC-13 / SC-008 / FR-013).
 *
 * ── Why the assertion goes further than "no bytes" ───────────────────────────────────────────────
 * Feature 012's live run found that a private note's ID and its MENTIONS leaked alongside the body
 * when only the body was being thought about. So this asserts the absence of the attachment id and
 * the upload id, not merely of the file. An id is a reference a customer should never learn exists,
 * and it is the part that survives careless serialisation.
 *
 * ── Why this is inheritance, not a second implementation ─────────────────────────────────────────
 * Attachments load THROUGH the message, as a nested select. The customer projection already excludes
 * private rows AT THE QUERY, so their attachment rows are never loaded — there is no filtering step
 * here that could be forgotten. The fake below reproduces that: it honours `where.private`, so
 * "absent" is the structural outcome of the query, not a post-filter in the test.
 */
const CONV = 'c1';

const stored = [
  {
    id: 'm-public',
    conversation_id: CONV,
    account_id: 'acc-1',
    author_type: 'operator',
    author_id: 'op-1',
    body: 'here is your receipt',
    private: false,
    mentions: [],
    created_at: new Date('2026-07-29T10:00:00.000Z'),
    attachments: [{ upload_id: 'up-public', position: 0 }],
  },
  {
    id: 'm-note',
    conversation_id: CONV,
    account_id: 'acc-1',
    author_type: 'operator',
    author_id: 'op-2',
    body: 'internal: passport scan attached, do NOT send',
    private: true,
    mentions: ['op-3'],
    created_at: new Date('2026-07-29T11:00:00.000Z'),
    attachments: [{ upload_id: 'up-secret', position: 0 }],
  },
];

/** Honours the query-level private exclusion, exactly as the scoped Prisma client does. */
function fakePrisma() {
  const findMany = jest.fn(({ where }: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
    Promise.resolve(
      stored.filter((m) => {
        if (where.conversation_id && m.conversation_id !== where.conversation_id) return false;
        if (where.private === false && m.private) return false;
        if (where.author_type && m.author_type === 'system') return false;
        return true;
      }),
    ),
  );
  const forAccount = jest.fn(() => ({
    message: { findMany },
    conversation: { findFirst: jest.fn().mockResolvedValue({ brand_id: 'brand-a' }) },
  }));
  return { prisma: { forAccount } as unknown as PrismaService, findMany };
}

const described = new Map<string, AttachmentWire>([
  [
    'up-public',
    { uploadId: 'up-public', contentType: 'application/pdf', byteSize: 100, displayName: 'receipt.pdf', hasDerivative: false },
  ],
  [
    'up-secret',
    { uploadId: 'up-secret', contentType: 'image/png', byteSize: 200, displayName: 'passport.png', hasDerivative: true },
  ],
]);

describe('*** the customer projection carries no trace of a private note’s attachment ***', () => {
  it('no bytes, no metadata, and NO IDS', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'customer', 50, null);
    const payload = JSON.stringify(rows.map((r) => toMessageWire(r, described)));

    // The note itself is not in the result set at all…
    expect(rows.map((r) => r.id)).toEqual(['m-public']);
    // …so nothing of it can be serialised: not the id, not the upload id, not the filename.
    expect(payload).not.toContain('m-note');
    expect(payload).not.toContain('up-secret');
    expect(payload).not.toContain('passport');
    expect(payload).not.toContain('op-3'); // the 012 lesson: mentions leaked too
    expect(payload).not.toContain('do NOT send');
  });

  it('the exclusion happens in the QUERY, not after it', async () => {
    const { prisma, findMany } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'customer', 50, null);
    // If `private: false` were ever dropped from the predicate, a private note would be LOADED and
    // the guarantee would rest on a mapper remembering to drop it — which is the shape of the bug.
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ private: false });
  });

  it('attachments are selected THROUGH the message — never by a separate query', async () => {
    const { prisma, findMany } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'customer', 50, null);
    const select = findMany.mock.calls[0]![0].select as Record<string, unknown>;
    // A nested select is what makes the private-note exclusion cover attachments for free. A separate
    // `messageAttachment.findMany` would bypass it entirely, which is why its absence is asserted.
    expect(select.attachments).toBeDefined();
  });

  it('the public message DOES carry its attachment', async () => {
    // Otherwise the test above would pass on a projection that simply drops all attachments.
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'customer', 50, null);
    const wire = toMessageWire(rows[0]!, described);
    expect(wire.attachments).toHaveLength(1);
    expect(wire.attachments[0]!.uploadId).toBe('up-public');
  });
});

describe('the STAFF projection sees everything, as it must', () => {
  it('the private note and its attachment are present for staff', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'staff', 50, null);
    const wire = rows.map((r) => toMessageWire(r, described));
    expect(wire.map((w) => w.id)).toEqual(['m-public', 'm-note']);
    expect(wire[1]!.attachments[0]!.uploadId).toBe('up-secret');
  });
});

describe('an attachment with no description is dropped, not half-rendered', () => {
  it('an upload the caller cannot see contributes nothing', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder(), noOutbox()).thread('acc-1', CONV, 'staff', 50, null);
    // An empty description map models "users returned nothing for these ids".
    const wire = toMessageWire(rows[1]!, new Map());
    expect(wire.attachments).toEqual([]);
    // A half-filled attachment (id but no type or size) renders as a broken one, which is worse than
    // an absent one: it tells the operator a file is there and then fails to open.
    expect(JSON.stringify(wire)).not.toContain('up-secret');
  });
});
