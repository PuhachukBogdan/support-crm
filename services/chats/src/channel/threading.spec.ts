import { ThreadResolver } from './threading';

/**
 * T035 (feature 033, US2) — **where a reply belongs** (FR-029/FR-030/FR-031).
 * FAILS before `threading.ts` exists, PASSES after.
 *
 * ⚠️ A wrong split cannot be undone: twenty tickets from one conversation are twenty real tickets with
 * twenty real histories and nothing recording that they were once one thread. So these tests are as much
 * about what the resolver REFUSES to match on as about what it matches.
 */

interface Row {
  external_id: string | null;
  conversation: { id: string; brand_id: string; status: string } | null;
}

function harness(rows: Row[]) {
  const asked: Array<Record<string, unknown>> = [];
  const prisma = {
    forAccount: () => ({
      message: {
        findMany: async (args: { where: { external_id: { in: string[] } } }) => {
          asked.push(args.where);
          const wanted = new Set(args.where.external_id.in);
          return rows.filter((r) => r.external_id && wanted.has(r.external_id));
        },
      },
    }),
  } as unknown as import('../prisma.service').PrismaService;
  return { resolver: new ThreadResolver(prisma), asked };
}

const conv = (id: string, brand = 'brand-1', status = 'open') => ({ id, brand_id: brand, status });

describe('the happy path: a reply joins the ticket of the message it answers', () => {
  it('matches In-Reply-To and carries the status the reopen rule needs', async () => {
    const { resolver } = harness([
      { external_id: '<ours-42@crm>', conversation: conv('conv-9', 'brand-1', 'solved') },
    ]);
    await expect(
      resolver.resolve('acc-1', 'brand-1', { inReplyTo: '<ours-42@crm>' }),
    ).resolves.toEqual({ conversationId: 'conv-9', status: 'solved' });
  });

  it('prefers In-Reply-To over the References chain, and the chain NEWEST-first', async () => {
    // ⚠️ The load-bearing ordering. RFC 5322 writes `References` oldest-first and the adapter reverses
    // it; if that reversal were ever dropped, a fifty-message thread would resolve against its OLDEST
    // ancestor — and on a thread continued after a `closed` ticket that is the difference between
    // joining the live conversation and joining the archived one.
    const { resolver } = harness([
      { external_id: '<old@crm>', conversation: conv('conv-old') },
      { external_id: '<recent@crm>', conversation: conv('conv-recent') },
      { external_id: '<answered@crm>', conversation: conv('conv-answered') },
    ]);

    await expect(
      resolver.resolve('acc-1', 'brand-1', {
        inReplyTo: '<answered@crm>',
        references: ['<recent@crm>', '<old@crm>'],
      }),
    ).resolves.toEqual({ conversationId: 'conv-answered', status: 'open' });

    // With no In-Reply-To, the FIRST reference wins — which is the newest, because the adapter reversed.
    await expect(
      resolver.resolve('acc-1', 'brand-1', { references: ['<recent@crm>', '<old@crm>'] }),
    ).resolves.toEqual({ conversationId: 'conv-recent', status: 'open' });
  });
});

describe('what it refuses to guess (FR-031)', () => {
  it('headers referencing nothing we hold → no match, so the caller creates a ticket', async () => {
    const { resolver } = harness([{ external_id: '<ours@crm>', conversation: conv('conv-1') }]);
    await expect(
      resolver.resolve('acc-1', 'brand-1', {
        inReplyTo: '<somebody-elses@example.com>',
        references: ['<also-not-ours@example.com>'],
      }),
    ).resolves.toBeNull();
  });

  it('no threading headers at all → no match, and no query is even attempted', async () => {
    const { resolver, asked } = harness([{ external_id: '<ours@crm>', conversation: conv('conv-1') }]);
    await expect(resolver.resolve('acc-1', 'brand-1', {})).resolves.toBeNull();
    // A first email from a stranger refers to nothing. Asserting the absence of the query keeps the
    // busiest write path in the product from paying for the commonest case.
    expect(asked).toHaveLength(0);
  });

  it('a match under ANOTHER BRAND is discarded rather than used (FR-020)', async () => {
    // Brands have separate mailboxes, so a cross-brand thread is either a misconfiguration or a forged
    // header. Both must produce a new ticket instead of moving a conversation into a brand whose agents
    // were never meant to see it.
    const { resolver } = harness([
      { external_id: '<ours@crm>', conversation: conv('conv-1', 'brand-OTHER') },
    ]);
    await expect(
      resolver.resolve('acc-1', 'brand-1', { inReplyTo: '<ours@crm>' }),
    ).resolves.toBeNull();
  });

  it('blank candidates are dropped before the query, never matched against a blank row', async () => {
    const { resolver, asked } = harness([{ external_id: '<ours@crm>', conversation: conv('conv-1') }]);
    await expect(
      resolver.resolve('acc-1', 'brand-1', { inReplyTo: '   ', references: ['', '  '] }),
    ).resolves.toBeNull();
    expect(asked).toHaveLength(0);
  });
});

describe('the query itself', () => {
  it('asks ONCE for every candidate, not once per candidate', async () => {
    // A long References chain on a fifty-message thread would otherwise be fifty round trips on the
    // busiest write path in the product (Principle VII).
    const { resolver, asked } = harness([]);
    await resolver.resolve('acc-1', 'brand-1', {
      inReplyTo: '<a@crm>',
      references: ['<b@crm>', '<c@crm>', '<a@crm>'],
    });
    expect(asked).toHaveLength(1);
    // De-duplicated: `<a@crm>` appears in both headers and is asked for once.
    expect(asked[0]!.external_id).toEqual({ in: ['<a@crm>', '<b@crm>', '<c@crm>'] });
  });
});
