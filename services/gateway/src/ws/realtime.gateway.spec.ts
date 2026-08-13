import { JwtService } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { realtimeChannel, type RealtimeEvent } from '@crm/common';
import { RealtimeGateway } from './realtime.gateway';
import type { GatewayConfig } from '../config';
import type { RedisService } from '../redis/redis.service';

/**
 * T023 (feature 034, W4 — FR-006/FR-007/FR-009) — **the realtime edge authorizes, and rooms are the
 * account from the TOKEN.**
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ Before this gateway the socket surface was **completely unauthenticated**: `AuthGuard` returns `true`
 * for every non-HTTP context, by its own explicit design. So these are not defence-in-depth assertions —
 * they are the only authorization this edge has.
 *
 * The invariant of the block is tenant isolation, and the test that matters is the third one: two accounts,
 * one event, and the other account's socket receives **nothing**.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const SECRET = 'a-test-secret-of-at-least-32-characters-long';
const jwt = new JwtService({});
const cfg = { JWT_SECRET: SECRET } as unknown as GatewayConfig;

const tokenFor = (accountId: string, userId = 'u-1') =>
  jwt.sign({ sub: userId, account_id: accountId }, { secret: SECRET });

const upgrade = (cookie?: string): IncomingMessage =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as IncomingMessage;

/** A socket double: what it received, and whether it was closed and with what code. */
function socket() {
  const frames: string[] = [];
  const closed: number[] = [];
  let onClose: (() => void) | undefined;
  return {
    frames,
    closed,
    fireClose: () => onClose?.(),
    client: {
      send: (data: string) => frames.push(data),
      close: (code?: number) => closed.push(code ?? 1000),
      on: (_event: 'close', handler: () => void) => {
        onClose = handler;
      },
    },
  };
}

/**
 * A Redis double that records subscriptions and lets a test push a message, standing in for the whole
 * `duplicate()` → `subscribe` → `on('message')` chain.
 */
function redisDouble() {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let deliver: ((channel: string, payload: string) => void) | undefined;
  const sub = {
    on: (event: string, handler: (...args: never[]) => void) => {
      if (event === 'message') deliver = handler as unknown as (c: string, p: string) => void;
    },
    subscribe: async (channel: string) => {
      subscribed.push(channel);
      return 1;
    },
    unsubscribe: async (channel: string) => {
      unsubscribed.push(channel);
      return 1;
    },
    disconnect: () => undefined,
  };
  return {
    subscribed,
    unsubscribed,
    push: (channel: string, payload: string) => deliver?.(channel, payload),
    service: { client: { duplicate: () => sub } } as unknown as RedisService,
  };
}

const build = () => {
  const redis = redisDouble();
  // ⭐ W32: an empty deny-list bans nobody, so every assertion in this file is unaffected — which is
  // exactly the default this list must have.
  // ⭐ W32: an empty deny-list bans nobody, so every assertion in this file is unaffected — which is
  // exactly the default this list must have. Both readers are stubbed: the socket awaits its copy.
  const denied = { current: () => [] as string[], currentAwaited: async () => [] as string[] };
  return { redis, denied, gateway: new RealtimeGateway(redis.service, jwt, cfg, denied as never) };
};

/** Connections are established asynchronously (the subscribe is awaited internally). */
const settle = () => new Promise((r) => setImmediate(r));

const EVENT: RealtimeEvent = {
  kind: 'conversation.created',
  accountId: 'acc-a',
  conversationId: 'conv-1',
};

describe('a connection is authorized at the handshake (FR-006)', () => {
  it('a valid access cookie joins the account of its token', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    expect(a.closed).toEqual([]);
    expect(redis.subscribed).toEqual([realtimeChannel('acc-a')]);
  });

  it.each([
    ['no cookie at all', undefined],
    ['a cookie without the access token', 'refresh=whatever'],
    ['a malformed token', 'access=not-a-jwt'],
    ['a token signed with another secret', `access=${new JwtService({}).sign({ sub: 'u', account_id: 'acc-a' }, { secret: 'another-secret-of-at-least-32-chars!!' })}`],
  ])('%s ⇒ the socket is CLOSED, not left open and silent', async (_name, cookie) => {
    const { gateway, redis } = build();
    const s = socket();
    gateway.handleConnection(s.client, upgrade(cookie));
    await settle();

    // ⭐ Closed, with policy-violation. An idle-but-connected socket is indistinguishable from "nothing is
    // happening", so a client whose cookie expired would sit for ever believing it was current.
    expect(s.closed).toEqual([1008]);
    expect(redis.subscribed).toEqual([]);
  });

  /**
   * ⚠️ A token with no `account_id` verifies cryptographically and is still useless — and worse than
   * useless: an empty account would build one room every tenant could land in. Refused a layer before
   * `realtimeChannel` would have thrown.
   */
  it('a signed token with no account is refused', async () => {
    const { gateway, redis } = build();
    const s = socket();
    const token = jwt.sign({ sub: 'u-1' }, { secret: SECRET });
    gateway.handleConnection(s.client, upgrade(`access=${token}`));
    await settle();
    expect(s.closed).toEqual([1008]);
    expect(redis.subscribed).toEqual([]);
  });
});

describe('an event reaches its own account and no other (FR-009 — the block\'s invariant)', () => {
  it('⭐ TWO ACCOUNTS, ONE EVENT: the other account receives nothing', async () => {
    const { gateway, redis } = build();
    const a = socket();
    const b = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    gateway.handleConnection(b.client, upgrade(`access=${tokenFor('acc-b')}`));
    await settle();

    redis.push(realtimeChannel('acc-a'), JSON.stringify(EVENT));

    // The positive control first: an "is empty" assertion passes just as well when the whole delivery path
    // is broken, which is the vacuous shape this project has hit seven times.
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toEqual([]);
  });

  it('every socket of the same account receives it', async () => {
    const { gateway, redis } = build();
    const one = socket();
    const two = socket();
    gateway.handleConnection(one.client, upgrade(`access=${tokenFor('acc-a')}`));
    gateway.handleConnection(two.client, upgrade(`access=${tokenFor('acc-a', 'u-2')}`));
    await settle();

    redis.push(realtimeChannel('acc-a'), JSON.stringify(EVENT));
    expect(one.frames).toHaveLength(1);
    expect(two.frames).toHaveLength(1);
    // …and the account was subscribed once, not once per socket.
    expect(redis.subscribed).toEqual([realtimeChannel('acc-a')]);
  });

  /**
   * ⭐ The channel says one tenant and the payload says another. Nothing legitimate produces this, so it is
   * refused rather than resolved in either direction — choosing one would be choosing which of two
   * untrusted claims to trust.
   */
  it('refuses an event whose channel and payload disagree about the account', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    redis.push(realtimeChannel('acc-a'), JSON.stringify({ ...EVENT, accountId: 'acc-b' }));
    expect(a.frames).toEqual([]);
  });
});

describe('the gateway forwards and does NOT enrich (FR-001/FR-008)', () => {
  /**
   * ⚠️ The shortcut this forbids is real and tempting: the gateway holds a chats client, so it *could* add
   * the subject. That is the single change that would turn a notification into an unauthorized read, so the
   * frame is asserted to equal the payload.
   */
  it('the frame carries the parsed event and nothing more', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    redis.push(realtimeChannel('acc-a'), JSON.stringify(EVENT));
    expect(JSON.parse(a.frames[0]!)).toEqual({ event: 'realtime', data: EVENT });
  });

  it('a field the publisher never should have sent is DROPPED on the way out', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    redis.push(
      realtimeChannel('acc-a'),
      JSON.stringify({ ...EVENT, subject: 'Не приходит вывод', fromAddress: 'p@mail.test' }),
    );
    expect(a.frames[0]).not.toContain('вывод');
    expect(a.frames[0]).not.toContain('p@mail.test');
  });

  it('an unreadable frame is dropped rather than forwarded raw', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    redis.push(realtimeChannel('acc-a'), 'not json');
    expect(a.frames).toEqual([]);
  });
});

describe('rooms are released (and the traffic with them)', () => {
  it('the last socket of an account leaving unsubscribes the channel', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();

    a.fireClose();
    await settle();
    expect(redis.unsubscribed).toEqual([realtimeChannel('acc-a')]);
  });

  it('a second socket keeps the room alive', async () => {
    const { gateway, redis } = build();
    const one = socket();
    const two = socket();
    gateway.handleConnection(one.client, upgrade(`access=${tokenFor('acc-a')}`));
    gateway.handleConnection(two.client, upgrade(`access=${tokenFor('acc-a', 'u-2')}`));
    await settle();

    one.fireClose();
    await settle();
    expect(redis.unsubscribed).toEqual([]);

    redis.push(realtimeChannel('acc-a'), JSON.stringify(EVENT));
    expect(two.frames).toHaveLength(1);
  });

  it('a closed socket receives nothing afterwards', async () => {
    const { gateway, redis } = build();
    const a = socket();
    gateway.handleConnection(a.client, upgrade(`access=${tokenFor('acc-a')}`));
    await settle();
    a.fireClose();
    await settle();

    redis.push(realtimeChannel('acc-a'), JSON.stringify(EVENT));
    expect(a.frames).toEqual([]);
  });
});

describe('a downed Redis degrades the socket and never the gateway', () => {
  /**
   * ⭐ Found by the ingress integration test, which boots the real module against a Redis that is not there
   * and printed `Error: Connection is closed.` **after passing**. The first draft did
   * `void this.channel().then((sub) => sub?.subscribe(...))` — no `.catch`, so an unreachable Redis turned
   * every connection into an unhandled promise rejection, which under Node's default is a process-level
   * crash. The gateway would have died from a downed cache while every REST route it serves was healthy.
   *
   * ⇒ No live updates is a degradation the client already handles (it re-reads on its own reconnect). A
   * dead gateway is not.
   */
  it('a subscribe that rejects leaves the socket open and raises nothing', async () => {
    const failing = {
      on: () => undefined,
      subscribe: async () => {
        throw new Error('Connection is closed.');
      },
      unsubscribe: async () => {
        throw new Error('Connection is closed.');
      },
      disconnect: () => undefined,
    };
    const service = { client: { duplicate: () => failing } } as unknown as RedisService;
    const gateway = new RealtimeGateway(service, jwt, cfg, {
      // ⭐ W32: an empty deny-list bans nobody, so every assertion below is unaffected — which is
      // exactly the default this list must have. The socket AWAITS its copy (a cold cache must not
      // let one upgrade through, and an upgrade is held rather than repeated).
      current: () => [],
      currentAwaited: async () => [],
    } as never);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const s = socket();
      gateway.handleConnection(s.client, upgrade(`access=${tokenFor('acc-a')}`));
      await settle();
      await settle();
      // The socket is authorized and stays open — it simply will not receive anything.
      expect(s.closed).toEqual([]);
      expect(rejections).toEqual([]);

      // …and the same on the way out.
      s.fireClose();
      await settle();
      await settle();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('there is no frame vocabulary for naming an account (FR-007)', () => {
  /**
   * ⭐ Stronger than validating such a request: the gateway declares **no** message handler at all, so a
   * client cannot ask to join anything. Tenant isolation rests on a value the client never supplies.
   *
   * Read from the source, because the property is an ABSENCE and absences are what silently regress.
   */
  it('no frame handler accepts an account', () => {
    const src = readFileSync(join(__dirname, 'realtime.gateway.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /**
     * ⚠️ Narrowed 2026-08-05: `ping` moved INTO this gateway (two classes on one path closed every
     * handshake), so "no message handler at all" is no longer the property — and it never was the point.
     * The property is that **no handler takes an account**: `ping` echoes its own payload and names no
     * tenant, so a client still cannot ask to join anything.
     */
    const handlers = [...code.matchAll(/@SubscribeMessage\('([^']+)'\)/g)].map((m) => m[1]);
    expect(handlers).toEqual(['ping']);
    expect(code).not.toMatch(/accountId\s*[:=][^;]*(MessageBody|data|payload|req|frame)/);
  });
});
