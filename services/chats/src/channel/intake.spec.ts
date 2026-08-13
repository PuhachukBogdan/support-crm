import { Logger } from '@nestjs/common';
import { ChannelIntakeService } from './intake.service';
import { ChannelRepository } from './channel.repository';
import { IntakeLedger } from './intake.ledger';
import { ApiChannelAdapter } from './adapters/api.adapter';
import { computeDigest, parseSignatureHeader, verifySignature } from './signature';
import type { ChannelConfig } from '../config';

/**
 * T021–T025 (feature 033, US1 — subpoint 2.1a) — **the API channel takes work in, exactly once.**
 * FAILS before `intake.service.ts` and its collaborators exist, PASSES after.
 *
 * ── What these six describes are for, and what they deliberately leave out ────────────────────────
 * The block's test minimum is one happy path and one refusal per subpoint, plus the invariants the
 * subpoint touches, plus idempotence on the writing path. So: the accept, the refusals that must write
 * nothing, the replay, the tenant boundary, and the log. NOT every field spelling the adapter tolerates,
 * and not one test per refusal class — the classes share one code path and one of them proves it.
 *
 * ⚠️ The fakes below are deliberately *stateful* rather than `jest.fn()` stubs returning fixed values. A
 * mock that always says "no such row" cannot show a replay being refused, and a replay is the single most
 * important thing in this file.
 */
const SECRET = 'a-shared-secret-of-at-least-32-characters';
const ACCOUNT = 'acc-1';
const OTHER_ACCOUNT = 'acc-2';

const CHANNEL = {
  id: 'ch-1',
  account_id: ACCOUNT,
  brand_id: 'brand-1',
  kind: 'api' as const,
  key: 'stand-api-brand1',
  address: null,
};

/** A channel of ANOTHER account, so "the credential decides the tenant" is falsifiable. */
const OTHER_CHANNEL = { ...CHANNEL, id: 'ch-2', account_id: OTHER_ACCOUNT, brand_id: 'brand-9', key: 'other-key' };

const CFG = (over: Partial<ChannelConfig> = {}): ChannelConfig => ({
  secrets: new Map([
    [CHANNEL.key, SECRET],
    [OTHER_CHANNEL.key, SECRET],
  ]),
  replayWindowSeconds: 300,
  emailAddress: '',
  maxAttempts: 5,
  ...over,
});

const NOW = 1_770_000_000;
const body = (eventId: string, text = 'my withdrawal is stuck') =>
  JSON.stringify({ event_id: eventId, message: { text } });
const sign = (raw: string, ts = NOW) => `t=${ts},v1=${computeDigest(SECRET, ts, raw)}`;

/** Everything the intake writes, so a test can assert both what happened and what did NOT. */
function harness(opts: { statusKeys?: Record<string, string | null> } = {}) {
  const written = {
    conversations: [] as Array<Record<string, unknown>>,
    messages: [] as Array<Record<string, unknown>>,
    ledger: [] as Array<Record<string, unknown>>,
  };

  const channels = {
    resolveByKey: async (key: string) =>
      key === CHANNEL.key ? CHANNEL : key === OTHER_CHANNEL.key ? OTHER_CHANNEL : null,
  } as unknown as ChannelRepository;

  // Stateful, keyed exactly as the real unique constraint is: `(channel_id, external_event_id)`.
  const accepted = new Map<string, { conversationId: string; messageId: string; intakeId: string }>();
  const ledger = {
    claim: async (input: { accountId: string; channelId: string; externalEventId: string }) => {
      const k = `${input.channelId}::${input.externalEventId}`;
      const prior = accepted.get(k);
      if (prior) return { fresh: false, ...prior };
      const intakeId = `intake-${accepted.size + 1}`;
      accepted.set(k, { intakeId, conversationId: '', messageId: '' });
      written.ledger.push({ ...input, outcome: 'accepted' });
      return { fresh: true, intakeId };
    },
    stampProduced: async (
      _a: string,
      intakeId: string,
      produced: { conversationId: string; messageId: string },
    ) => {
      for (const [k, v] of accepted) if (v.intakeId === intakeId) accepted.set(k, { ...v, ...produced });
    },
    recordRefusal: async (input: Record<string, unknown>) => {
      written.ledger.push({ ...input, outcome: 'refused' });
    },
  } as unknown as IntakeLedger;

  const conversations = {
    create: async (accountId: string, input: Record<string, unknown>) => {
      const row = { id: `conv-${written.conversations.length + 1}`, account_id: accountId, ...input };
      written.conversations.push(row);
      return row;
    },
  } as unknown as import('../conversation/conversation.repository').ConversationRepository;

  const messages = {
    post: async (accountId: string, input: Record<string, unknown>) => {
      const row = { id: `msg-${written.messages.length + 1}`, account_id: accountId, ...input };
      written.messages.push(row);
      return row;
    },
  } as unknown as import('../message/message.repository').MessageRepository;

  const statuses = {
    defaultKeyOfCategory: async (accountId: string, category: string) => {
      const map = opts.statusKeys ?? { new: 'new' };
      return category in map ? map[category as keyof typeof map] : null;
    },
  } as unknown as import('../status/status.repository').StatusRepository;

  /**
   * ⚠️ **THREADING must not be reached from this path, and the stub THROWS to say so.**
   *
   * Email threads; a widget session does not. A silent stub would let a future edit thread an API delivery
   * with every assertion here still green, and the result would be one customer's message appended to
   * another's conversation.
   *
   * ⓘ `participants` and `audit` were also throwing stubs until US3, when the API path legitimately began
   * to resolve the widget's player id and to record that it did. The change is recorded here rather than
   * quietly softened: these two are no longer boundaries, and threading still is.
   */
  const threads = {
    resolve: () => {
      throw new Error('the API intake path must not reach thread resolution');
    },
  } as unknown as import('./threading').ThreadResolver;
  const participants = {
    // US1's payload carries no identifier, so this is not reached by the tests in this file; US3's own
    // spec (`identity-event.spec.ts`) drives the resolved and ambiguous outcomes.
    resolve: async () => ({ participantId: '', playerId: '', ambiguous: false }),
  } as unknown as import('./participant.client').ChannelParticipantClient;
  const audit = {
    append: async () => undefined,
  } as unknown as import('../audit/audit.repository').AuditRepository;

  const service = new ChannelIntakeService(
    CFG(),
    channels,
    ledger,
    new ApiChannelAdapter(),
    conversations,
    messages,
    statuses,
    threads,
    participants,
    audit,
  );
  return { service, written };
}

describe('the signed happy path (FR-009/FR-016/FR-017)', () => {
  it('one delivery becomes one ticket and one customer message', async () => {
    const { service, written } = harness();
    const raw = body('evt-1');

    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });

    expect(out.refusal).toBeUndefined();
    expect(out.duplicate).toBe(false);
    expect(written.conversations).toHaveLength(1);
    expect(written.messages).toHaveLength(1);
    expect(written.messages[0]).toMatchObject({ authorType: 'player', isPrivate: false });
  });

  it('takes its status from the ACCOUNT’S catalogue, never a hardcoded word', async () => {
    // The account here calls its first-contact status `triage`. Nothing in the intake path may assume
    // `new` — that word is a seeded default a supervisor may have retired (FR-016).
    const { service, written } = harness({ statusKeys: { new: 'triage' } });
    const raw = body('evt-1');
    await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(written.conversations[0]).toMatchObject({ status: 'triage' });
  });

  it('⭐ records the unidentified state EXPLICITLY, not as a blank player', async () => {
    // ADR 0044 §1: a blank cannot distinguish "matched nobody" from "never looked", and their current
    // Zendesk is full of blanks nobody can interpret. Identity resolution itself is US3; the honest
    // answer until then is the state, stored.
    const { service, written } = harness();
    const raw = body('evt-1');
    await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(written.conversations[0]).toMatchObject({ identityState: 'unidentified' });
    // ⚠️ Asserted as "no VALUE" rather than "no key". US3 made the intake pass `playerId` explicitly —
    // `undefined` when nobody resolved — and the repository turns that into NULL. The property that matters
    // is that no player id was invented; whether the key is present with no value is a call-shape detail,
    // and pinning that would be a test about how the argument is built rather than about what is stored.
    expect(written.conversations[0]!.playerId).toBeUndefined();
  });

  it('refuses LOUDLY when the account has no status in the `new` category', async () => {
    // A misconfigured account must not receive an invented status key: the composite foreign key would
    // reject it anyway, on a customer's conversation, at a moment nobody is watching.
    const { service, written } = harness({ statusKeys: {} });
    const raw = body('evt-1');
    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(out.refusal).toBe('no_status_configured');
    expect(written.conversations).toHaveLength(0);
  });
});

describe('*** a refused delivery writes NO product data (FR-010) ***', () => {
  it.each([
    ['no signature at all', undefined],
    ['a forged digest', `t=${NOW},v1=${'0'.repeat(64)}`],
    ['a malformed header', 'nonsense'],
  ])('%s → refused, and nothing is written', async (_label, signature) => {
    const { service, written } = harness();
    const raw = body('evt-1');

    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: signature as string | undefined,
      receivedAt: NOW,
    });

    expect(out.refusal).toBe('signature');
    expect(written.conversations).toHaveLength(0);
    expect(written.messages).toHaveLength(0);
    // The refusal IS recorded — a rejection that leaves no trace is indistinguishable from a delivery
    // that never arrived, and those have opposite causes.
    expect(written.ledger.filter((l) => l.outcome === 'refused')).toHaveLength(1);
  });

  it('⭐ a body altered after signing is refused — the signature covers the bytes', async () => {
    const { service, written } = harness();
    const raw = body('evt-1');
    const tampered = body('evt-1', 'my withdrawal is FINE');

    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: tampered,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(out.refusal).toBe('signature');
    expect(written.conversations).toHaveLength(0);
  });

  it('refuses a delivery outside the replay window as its own class', async () => {
    // Distinct from `signature` internally so a log can tell a forgery from a late retry — while the
    // gateway maps both to 401, because telling a caller which one it was narrows a forgery to the clock.
    const { service } = harness();
    const raw = body('evt-1');
    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw, NOW - 4_000),
      receivedAt: NOW,
    });
    expect(out.refusal).toBe('replay_window');
  });

  it('an unknown key refuses and records NOTHING — there is no tenant to record against', async () => {
    const { service, written } = harness();
    const raw = body('evt-1');
    const out = await service.acceptApiDelivery({
      channelKey: 'never-issued',
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(out.refusal).toBe('unknown_channel');
    // Deliberate: a row here would put a stranger's delivery in some tenant's ledger. The absence is the
    // information, and the gateway's 404 is what the caller sees.
    expect(written.ledger).toHaveLength(0);
  });

  it('refuses a payload with no derivable event id rather than generating one (FR-014)', async () => {
    const { service, written } = harness();
    const raw = JSON.stringify({ message: { text: 'hello' } });
    const out = await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    // A generated id would make every replay look new — the exact failure at-most-once intake prevents.
    expect(out.refusal).toBe('no_event_id');
    expect(written.conversations).toHaveLength(0);
  });
});

describe('*** the tenant boundary (Principle I / FR-011) ***', () => {
  it('⭐ the CREDENTIAL decides the brand — a brand named in the body is ignored', async () => {
    const { service, written } = harness();
    const raw = JSON.stringify({
      event_id: 'evt-1',
      message: { text: 'hello' },
      // A stranger claiming a brand. This is the one new way a party outside the system could aim at
      // another tenant, and the only defence is that nothing reads it.
      brand_id: 'brand-9',
      account_id: OTHER_ACCOUNT,
    });

    await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });

    expect(written.conversations[0]).toMatchObject({
      account_id: ACCOUNT,
      brandId: CHANNEL.brand_id,
    });
  });

  it('a second account’s channel writes into ITS OWN account', async () => {
    const { service, written } = harness();
    const raw = body('evt-1');
    await service.acceptApiDelivery({
      channelKey: OTHER_CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });
    expect(written.conversations[0]).toMatchObject({
      account_id: OTHER_ACCOUNT,
      brandId: OTHER_CHANNEL.brand_id,
    });
  });
});

describe('*** idempotence: the provider WILL retry (FR-012/FR-049) ***', () => {
  it('⭐ the same delivery ten times yields ONE ticket and ONE message', async () => {
    const { service, written } = harness();
    const raw = body('evt-1');
    const sig = sign(raw);

    const outcomes = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(
        await service.acceptApiDelivery({
          channelKey: CHANNEL.key,
          rawBodyText: raw,
          signature: sig,
          receivedAt: NOW,
        }),
      );
    }

    expect(written.conversations).toHaveLength(1);
    expect(written.messages).toHaveLength(1);
    // ⚠️ And every repeat is a SUCCESS carrying the same ids. Answering with an error would make a
    // provider retry for ever.
    expect(outcomes[0]!.duplicate).toBe(false);
    for (const out of outcomes.slice(1)) {
      expect(out.duplicate).toBe(true);
      expect(out.refusal).toBeUndefined();
      expect(out.conversationId).toBe(outcomes[0]!.conversationId);
    }
  });

  it('two DIFFERENT events on one channel are two tickets', async () => {
    // The other half of idempotence: dedup must key on the event, not on the channel.
    const { service, written } = harness();
    for (const id of ['evt-1', 'evt-2']) {
      const raw = body(id);
      await service.acceptApiDelivery({
        channelKey: CHANNEL.key,
        rawBodyText: raw,
        signature: sign(raw),
        receivedAt: NOW,
      });
    }
    expect(written.conversations).toHaveLength(2);
  });
});

describe('the signature primitives', () => {
  it('parses order-insensitively and ignores parts it does not know', () => {
    // A provider adding `v2=` for a future scheme must not break the one we understand.
    expect(parseSignatureHeader(`v1=${'a'.repeat(64)}, t=${NOW}, v2=whatever`)).toEqual({
      timestamp: NOW,
      digest: 'a'.repeat(64),
    });
  });

  it('rejects a non-hex digest rather than comparing attacker text', () => {
    expect(parseSignatureHeader(`t=${NOW},v1=not-hex!!`)).toBeNull();
  });

  it('⚠️ an ABSENT secret is a mismatch, never a pass', () => {
    // A channel whose secret is unconfigured cannot be verified, so nothing it sends may be accepted.
    const raw = body('evt-1');
    expect(
      verifySignature({
        header: sign(raw),
        rawBody: raw,
        secret: undefined,
        receivedAt: NOW,
        replayWindowSeconds: 300,
      }),
    ).toEqual({ ok: false, refusal: 'mismatch' });
  });

  it('does not throw on a short digest (length is checked before timingSafeEqual)', () => {
    // `timingSafeEqual` throws on differing lengths; letting it would turn a malformed header into a 500
    // reachable by anybody who can post to the route.
    const raw = body('evt-1');
    expect(() =>
      verifySignature({
        header: `t=${NOW},v1=abcd`,
        rawBody: raw,
        secret: SECRET,
        receivedAt: NOW,
        replayWindowSeconds: 300,
      }),
    ).not.toThrow();
  });
});

describe('*** no secret and no payload reaches a log (Principle IV / FR-047) ***', () => {
  it('logs the channel KIND and ids, never the body or the secret', async () => {
    // Spied on the Logger PROTOTYPE, not on an instance field: Nest's `Logger` is constructed privately
    // inside the service, so there is no instance to reach from here. The first draft of this test spied
    // on a property that does not exist and silently asserted over an empty array — a log-scan that
    // scans nothing is worse than no log-scan, because it reports success.
    const lines: string[] = [];
    const capture = (m: unknown) => void lines.push(String(m));
    const spies = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
    ];

    const { service } = harness();
    const raw = body('evt-1', 'card 4111 1111 1111 1111 and my email is a@b.test');
    await service.acceptApiDelivery({
      channelKey: CHANNEL.key,
      rawBodyText: raw,
      signature: sign(raw),
      receivedAt: NOW,
    });

    // ⚠️ The scan must have something to scan. A log-scan over an empty array reports success, which is
    // worse than having no scan at all — the first draft of this test did exactly that.
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('4111');
    expect(all).not.toContain('a@b.test');
    // …and it does carry what a diagnostician actually needs.
    expect(all).toContain('kind=api');
    for (const spy of spies) spy.mockRestore();
  });
});
