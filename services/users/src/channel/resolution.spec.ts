import { ChannelParticipantService } from './channel-participant.service';
import { hashContact } from '../player/contact-match';

/**
 * T048/T049 (feature 033, US3) — **who wrote, and the three ways the system declines to guess.**
 * FAILS before `resolvePlayer` exists, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ The two wrong answers here are NOT symmetric, which is why every test below leans the same way.
 * Failing to attach leaves a ticket marked unidentified that W9's manual attach fixes in one click.
 * Attaching wrongly puts one customer's words on another customer's record — and the note an agent
 * then writes there **stays after any correction** (ADR 0044 §5). So: brand-scoped, no choosing
 * between candidates, and no invented players.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

const SALT = 'x'.repeat(32);
process.env.CONTACT_HASH_SALT = SALT;

interface Row {
  brand_id: string;
  kind: string;
  value_hash: string;
  player_id: string;
}

function harness(opts: { matches?: Row[]; players?: Array<{ brand_id: string; player_id: string }> } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const queries: Array<Record<string, unknown>> = [];
  const prisma = {
    forAccount: () => ({
      contactMatch: {
        findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
          queries.push({ ...args.where, take: args.take });
          const w = args.where as { brand_id: string; kind: string; value_hash: string };
          const hits = (opts.matches ?? []).filter(
            (m) => m.brand_id === w.brand_id && m.kind === w.kind && m.value_hash === w.value_hash,
          );
          return hits.slice(0, args.take ?? hits.length).map((m) => ({ player_id: m.player_id }));
        },
      },
      player: {
        findFirst: async (args: { where: { brand_id: string; player_id: string } }) => {
          queries.push(args.where);
          return (
            (opts.players ?? []).find(
              (p) => p.brand_id === args.where.brand_id && p.player_id === args.where.player_id,
            ) ?? null
          );
        },
      },
      channelParticipant: {
        upsert: async (args: Record<string, unknown>) => {
          upserts.push(args);
          const create = args.create as { player_id?: string | null };
          return { id: 'part-1', player_id: create.player_id ?? null };
        },
      },
    }),
  } as unknown as import('../prisma.service').PrismaService;
  return { service: new ChannelParticipantService(prisma, SALT), upserts, queries };
}

const emailHash = (value: string) => hashContact('email', value, SALT)!;

const register = (
  service: ChannelParticipantService,
  over: Partial<Parameters<ChannelParticipantService['register']>[0]> = {},
) =>
  service.register({
    accountId: 'acc-1',
    brandId: 'brand-1',
    kind: 'email',
    address: 'player@mail.test',
    identifierKind: 'email',
    ...over,
  });

describe('an address that names exactly one player resolves to them (FR-019)', () => {
  it('links the ticket and stores the player on the envelope row', async () => {
    const { service, upserts } = harness({
      matches: [
        { brand_id: 'brand-1', kind: 'email', value_hash: emailHash('player@mail.test'), player_id: 'pl-7' },
      ],
    });
    await expect(register(service)).resolves.toEqual({
      participantId: 'part-1',
      playerId: 'pl-7',
      ambiguous: false,
    });
    // Written on the row too, so a later reply on the same address does not have to resolve again.
    expect((upserts[0]!.create as Record<string, unknown>).player_id).toBe('pl-7');
  });

  it('matches on the HASH, never on the value — no new surface over addresses in clear (FR-021a)', async () => {
    const { service, queries } = harness();
    await register(service);
    // The whole point of reusing feature 020's projection: matching needs equality, and equality does not
    // need the value. Nothing in the query carries the address.
    expect(queries[0]!.value_hash).toBe(emailHash('player@mail.test'));
    expect(JSON.stringify(queries[0])).not.toContain('player@mail.test');
  });

  it('normalises before hashing, so one human written two ways still matches', async () => {
    const { service } = harness({
      matches: [
        { brand_id: 'brand-1', kind: 'email', value_hash: emailHash('player@mail.test'), player_id: 'pl-7' },
      ],
    });
    await expect(register(service, { address: '  PLAYER@Mail.TEST ' })).resolves.toMatchObject({
      playerId: 'pl-7',
    });
  });
});

describe('the three ways it declines to guess', () => {
  it('nobody matches → unidentified, and the ticket still gets its envelope (FR-023)', async () => {
    const { service } = harness({ matches: [] });
    await expect(register(service)).resolves.toEqual({
      participantId: 'part-1',
      playerId: '',
      ambiguous: false,
    });
  });

  it('ANOTHER BRAND’s player with the same address does not attach (FR-020, ADR 0038)', async () => {
    // The same string under two brands is two people until a `Person` link says otherwise. This is the
    // collision ADR 0038 §3 already had to fix once, and here it would put a stranger's conversation on
    // somebody's record.
    const { service } = harness({
      matches: [
        { brand_id: 'brand-OTHER', kind: 'email', value_hash: emailHash('player@mail.test'), player_id: 'pl-9' },
      ],
    });
    await expect(register(service)).resolves.toMatchObject({ playerId: '', ambiguous: false });
  });

  it('MORE THAN ONE candidate → unidentified AND flagged ambiguous (FR-022)', async () => {
    // ⚠️ `ambiguous` is not decoration: "nobody has this address" and "several do and we declined" are
    // different facts, and W9's manual attach is the answer to the second.
    const hash = emailHash('player@mail.test');
    const { service, queries } = harness({
      matches: [
        { brand_id: 'brand-1', kind: 'email', value_hash: hash, player_id: 'pl-1' },
        { brand_id: 'brand-1', kind: 'email', value_hash: hash, player_id: 'pl-2' },
      ],
    });
    await expect(register(service)).resolves.toMatchObject({ playerId: '', ambiguous: true });
    // Capped at two: one is a match, two is already ambiguous. A support-entered placeholder on four
    // thousand records must not load four thousand rows to reach the same verdict.
    expect(queries[0]!.take).toBe(2);
  });

  it('a value that is not usable as evidence is unidentified rather than hashed anyway', async () => {
    // `normaliseContact` refuses a string that is not shaped like an address, and a phone fragment that
    // would match many people. An unusable value is the absence of evidence, not weak evidence.
    const { service, queries } = harness({ matches: [] });
    await expect(register(service, { address: 'not-an-address' })).resolves.toMatchObject({
      playerId: '',
    });
    expect(queries).toHaveLength(0);
  });
});

describe('a platform id resolves by EXISTENCE, and gets no envelope (US3 scenario 6)', () => {
  it('a known id links the ticket and writes no envelope row', async () => {
    const { service, upserts } = harness({ players: [{ brand_id: 'brand-1', player_id: 'pl-42' }] });
    await expect(
      register(service, { identifierKind: 'player_id', address: 'pl-42', kind: 'api' }),
    ).resolves.toEqual({ participantId: '', playerId: 'pl-42', ambiguous: false });
    // ⚠️ No row: an envelope exists to answer somebody, and a widget player id is not an address. The API
    // channel cannot carry an outbound message at all, so a row would claim a reply path that does not
    // exist — and would put a non-contact identifier in the column whose justification is contact values.
    expect(upserts).toHaveLength(0);
  });

  it('an id UNKNOWN to the brand never invents a player', async () => {
    const { service } = harness({ players: [{ brand_id: 'brand-OTHER', player_id: 'pl-42' }] });
    await expect(
      register(service, { identifierKind: 'player_id', address: 'pl-42', kind: 'api' }),
    ).resolves.toMatchObject({ playerId: '', ambiguous: false });
  });

  it('the existence check is BRAND-scoped — a GR8 id is unique only within a brand', async () => {
    const { service, queries } = harness({ players: [{ brand_id: 'brand-1', player_id: 'pl-42' }] });
    await register(service, { identifierKind: 'player_id', address: 'pl-42', kind: 'api' });
    expect(queries[0]).toEqual({ brand_id: 'brand-1', player_id: 'pl-42' });
  });
});

describe('a resolution never clears a link it once made', () => {
  it('fills the player in when it finds one, and leaves the row alone when it does not', async () => {
    // ⚠️ Asymmetric on purpose. Filling it in is new knowledge — an address we could not place last week
    // now matches a player who registered it since. Clearing it would be the opposite: a `ContactMatch`
    // row that has gone (a corrected email, a GR8 sync) would silently unlink threads an agent is working,
    // and the customer's history would move out from under them.
    const found = harness({
      matches: [
        { brand_id: 'brand-1', kind: 'email', value_hash: emailHash('player@mail.test'), player_id: 'pl-7' },
      ],
    });
    await register(found.service);
    expect(found.upserts[0]!.update).toEqual({ player_id: 'pl-7' });

    const none = harness({ matches: [] });
    await register(none.service);
    expect(none.upserts[0]!.update).toEqual({});
  });
});
