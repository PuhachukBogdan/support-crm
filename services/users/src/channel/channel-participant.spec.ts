import { Logger } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { ChannelParticipantService } from './channel-participant.service';
import { MaintenanceController } from '../maintenance/maintenance.controller';

/**
 * T043 (feature 033, US2) — **where to answer a customer, owned by the service that owns addresses.**
 * FAILS before `channel-participant.service.ts` exists, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ This is the far end of the load-bearing decision of the feature (research R9): replying to an email
 * needs the address the customer wrote FROM, a hash cannot give it back, and the player's registered
 * address must not stand in for it. So the value is stored in clear — here, where the masking regime, the
 * field-tier policy and the hash salt already are — and `chats` holds only the handle.
 *
 * The three properties that make that safe are each a test below: the row is **brand-scoped**, the
 * registration is **idempotent by the unique key** rather than by a prior read, and **nothing logs the
 * address**.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⓘ The resolution half — matching a salted hash against `ContactMatch` — arrives in US3 and extends this
 * file. Until then `playerId` is empty, which is an honest answer rather than a missing feature: a ticket
 * that exists and is marked as belonging to nobody yet is exactly what ADR 0044 §1 asks for.
 */

interface UpsertCall {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  /** Empty on purpose — see the idempotence test: a returning participant's row is not touched. */
  update: Record<string, unknown>;
}

function harness(existing?: { id: string; player_id: string | null }) {
  const calls: UpsertCall[] = [];
  const prisma = {
    forAccount: (accountId: string) => ({
      // US3 added a resolution step ahead of the upsert. Stubbed to find NOTHING here on purpose: this
      // file is about the envelope row and the rpc's refusals, and `resolution.spec.ts` owns the matching
      // outcomes. A stub that returned a player would make every assertion below depend on two rules.
      contactMatch: { findMany: async () => [] },
      player: { findFirst: async () => null },
      channelParticipant: {
        upsert: async (args: UpsertCall) => {
          calls.push(args);
          void accountId;
          return existing ?? { id: 'part-1', player_id: null };
        },
      },
    }),
  } as unknown as import('../prisma.service').PrismaService;
  // The salt is injected, so a test supplies it directly — and a service with none would not construct.
  return { service: new ChannelParticipantService(prisma, 's'.repeat(32)), calls };
}

const system = () => {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  return md;
};

describe('registering where to answer', () => {
  it('returns an opaque handle and an honestly empty player id', async () => {
    const { service } = harness();
    await expect(
      service.register({
        accountId: 'acc-1',
        brandId: 'brand-1',
        kind: 'email',
        address: 'player@mail.test',
      }),
    ).resolves.toEqual({ participantId: 'part-1', playerId: '', ambiguous: false });
  });

  it('folds case so one human is one participant, not one per mail client', async () => {
    // The local part is case-sensitive per RFC 5321 and case-insensitive at every provider in practice.
    // Normalised by case and whitespace only — the same conservative treatment `normaliseContact` gives
    // an email, and for the same reason: correcting presentation is safe, guessing identity is not.
    const { service, calls } = harness();
    await service.register({
      accountId: 'acc-1',
      brandId: 'brand-1',
      kind: 'email',
      address: '  Player@Mail.TEST ',
    });
    expect(calls[0]!.create.address).toBe('player@mail.test');
  });

  it('is idempotent by the UNIQUE KEY, and touches nothing on a returning customer', async () => {
    // ⚠️ An `upsert` on the unique key is one statement the database serialises. A `findFirst` followed by
    // a `create` is the race this project has paid for twice — and here it would give one customer two
    // handles, so two replies in one thread could go to two different rows.
    const { service, calls } = harness({ id: 'part-existing', player_id: 'pl-9' });
    const out = await service.register({
      accountId: 'acc-1',
      brandId: 'brand-1',
      kind: 'email',
      address: 'player@mail.test',
    });
    expect(out).toEqual({ participantId: 'part-existing', playerId: 'pl-9', ambiguous: false });
    // Nothing to change: the row is a stable handle, and touching it would lose the one fact it carries —
    // when we first heard from this address.
    expect(calls[0]!.update).toEqual({});
    expect(calls[0]!.where).toEqual({
      account_id_brand_id_kind_address: {
        account_id: 'acc-1',
        brand_id: 'brand-1',
        kind: 'email',
        address: 'player@mail.test',
      },
    });
  });
});

describe('the rpc refuses before it registers anything', () => {
  const build = () => {
    const { service, calls } = harness();
    const ctrl = new MaintenanceController(
      {} as never,
      {} as never,
      {} as never,
      service,
    );
    return { ctrl, calls };
  };

  it('a non-system caller is refused — no gateway route, no session may reach this', async () => {
    const { ctrl, calls } = build();
    await expect(
      ctrl.resolveChannelParticipant(
        { accountId: 'acc-1', brandId: 'brand-1', channelKind: 'email', value: 'p@mail.test' },
        new Metadata(),
      ),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('a MISSING BRAND is refused rather than defaulted (ADR 0038)', async () => {
    // Identity is brand-scoped: the same address under two brands is two people until a `Person` link
    // says otherwise. So an absent brand is not "any brand" — it is a cross-brand attachment waiting to
    // happen, and one customer's words landing on another customer's record.
    const { ctrl, calls } = build();
    await expect(
      ctrl.resolveChannelParticipant(
        { accountId: 'acc-1', brandId: '', channelKind: 'email', value: 'p@mail.test' },
        system(),
      ),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('an empty value is refused — there is nothing to answer', async () => {
    const { ctrl, calls } = build();
    await expect(
      ctrl.resolveChannelParticipant(
        { accountId: 'acc-1', brandId: 'brand-1', channelKind: 'email', value: '  ' },
        system(),
      ),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe('the address never reaches a log (FR-047, research R10)', () => {
  it('logs nothing about the request, on the accepted path or the refused ones', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const { service } = harness();
      const ctrl = new MaintenanceController({} as never, {} as never, {} as never, service);
      await ctrl.resolveChannelParticipant(
        { accountId: 'acc-1', brandId: 'brand-1', channelKind: 'email', value: 'Player@Mail.TEST' },
        system(),
      );
      await ctrl
        .resolveChannelParticipant(
          { accountId: 'acc-1', brandId: '', channelKind: 'email', value: 'Player@Mail.TEST' },
          system(),
        )
        .catch(() => undefined);

      // ⚠️ This path is one of the few where the correct number of log lines is ZERO, so the usual
      // "assert there is something to scan first" guard does not apply — there is deliberately nothing.
      // What makes the test non-vacuous is that it drives the real handler both ways: if a future edit
      // adds a line quoting the request, `lines` stops being empty and this fails.
      expect(lines.join('\n')).not.toMatch(/player@mail\.test/i);
      expect(lines).toHaveLength(0);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
