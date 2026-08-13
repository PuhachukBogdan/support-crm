import { createWsPort, parseFrame, type WsFactory } from './ws-port';
import type { RealtimeEvent } from '../data-access';

/**
 * T035 (feature 034, W4 — FR-011/FR-012/FR-013) — the socket transport's own behaviour.
 *
 * ⚠️ Everything here runs without a server, a timer or a gateway: the socket factory and the scheduler are
 * injected. The point is that a reconnect POLICY is testable — the last transport in this seam
 * (`gotchas/wired-only-in-tests`) was correct in tests and never bound to anything, so the policy is
 * asserted at the level that owns it rather than left to an end-to-end run to notice.
 */
type Handler = (ev: unknown) => void;

function fakeSocket() {
  const handlers = new Map<string, Handler[]>();
  const closed: boolean[] = [];
  const on = (type: string, h: Handler) => {
    const list = handlers.get(type) ?? [];
    list.push(h);
    handlers.set(type, list);
  };
  return {
    closed,
    fire: (type: string, ev?: unknown) => (handlers.get(type) ?? []).forEach((h) => h(ev)),
    socket: {
      addEventListener: (type: 'message' | 'close' | 'open' | 'error', h: Handler) => on(type, h),
      close: () => closed.push(true),
    },
  };
}

/** A factory handing out fresh sockets and recording every connection attempt. */
function factoryOf() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const factory: WsFactory = () => {
    const s = fakeSocket();
    sockets.push(s);
    return s.socket as unknown as ReturnType<WsFactory>;
  };
  return { sockets, factory };
}

/**
 * ⚠️ Typed as a loose record on purpose. Its whole job is to build frames a server should never send —
 * an unknown kind, a subject, a missing id — so typing it as a valid `RealtimeEvent` would make the
 * invalid cases unwritable, and those are the ones worth asserting.
 */
const FRAME = (event: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'realtime',
    data: {
      kind: 'conversation.created',
      accountId: 'acc-1',
      conversationId: 'conv-1',
      ...event,
    },
  });

describe('a frame becomes an event, and anything else does not', () => {
  it('reads the three server kinds', () => {
    for (const kind of ['conversation.created', 'conversation.updated', 'message.created']) {
      expect(parseFrame(FRAME({ kind }))?.kind).toBe(kind);
    }
  });

  /**
   * ⭐ The third place this boundary is re-asserted: the publisher builds it, the gateway re-parses it, and
   * here it lands in a browser. Belt and braces on purpose — this is the promise that a customer's words
   * never reach a screen through the socket.
   */
  it('DROPS a subject, a body and an address if a server ever sends them', () => {
    const event = parseFrame(
      FRAME({ subject: 'Не приходит вывод', bodyText: 'третий день', fromAddress: 'p@mail.test' }),
    );
    expect(event).toEqual({
      kind: 'conversation.created',
      accountId: 'acc-1',
      conversationId: 'conv-1',
    });
    expect(JSON.stringify(event)).not.toContain('вывод');
    expect(JSON.stringify(event)).not.toContain('p@mail.test');
  });

  it.each([
    ['a pong from the other gateway', JSON.stringify({ event: 'pong', data: { n: 1 } })],
    ['an unknown kind', FRAME({ kind: 'note.created' })],
    ['a missing conversation', JSON.stringify({ event: 'realtime', data: { kind: 'message.created', accountId: 'a' } })],
    ['not json', 'not json'],
  ])('ignores %s', (_name, raw) => {
    expect(parseFrame(raw)).toBeNull();
  });
});

describe('one socket, many subscribers (FR-011)', () => {
  it('delivers one event to every handler exactly once', () => {
    const { sockets, factory } = factoryOf();
    const port = createWsPort({ url: 'ws://x', factory });
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    port.subscribe((e) => a.push(e));
    port.subscribe((e) => b.push(e));

    sockets[0]!.fire('message', { data: FRAME() });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // ⚠️ ONE connection, not one per subscriber: a socket per component would deliver the same event N
    // times and trigger N re-reads.
    expect(sockets).toHaveLength(1);
  });

  it('unsubscribing stops delivery to that handler only', () => {
    const { sockets, factory } = factoryOf();
    const port = createWsPort({ url: 'ws://x', factory });
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    const off = port.subscribe((e) => a.push(e));
    port.subscribe((e) => b.push(e));

    off();
    sockets[0]!.fire('message', { data: FRAME() });
    expect(a).toEqual([]);
    expect(b).toHaveLength(1);
  });
});

describe('a dropped socket reconnects, and the reconnect is announced (FR-013)', () => {
  it('reconnects with a growing delay', () => {
    const delays: number[] = [];
    const { sockets, factory } = factoryOf();
    createWsPort({
      url: 'ws://x',
      factory,
      backoffMs: [10, 20, 40],
      setTimeoutFn: (fn, ms) => {
        delays.push(ms);
        fn();
        return 0;
      },
    });

    sockets[0]!.fire('close');
    sockets[1]!.fire('close');
    sockets[2]!.fire('close');

    expect(delays).toEqual([10, 20, 40]);
    // …and the last delay is reused rather than growing past the schedule.
    sockets[3]!.fire('close');
    expect(delays).toEqual([10, 20, 40, 40]);
  });

  /**
   * ⭐⭐ The property that makes reconnection worth anything: **the interval a socket was down for is
   * exactly when its events were missed.** A reconnect that does not tell anybody leaves a screen stale
   * indefinitely, which looks identical to a working socket on a quiet day.
   */
  it('announces a RE-connection, and stays silent on the first one', () => {
    const { sockets, factory } = factoryOf();
    const port = createWsPort({
      url: 'ws://x',
      factory,
      backoffMs: [1],
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });
    const seen: RealtimeEvent[] = [];
    port.subscribe((e) => seen.push(e));

    // The first connection opening is NOT an event: the page has already read.
    sockets[0]!.fire('open');
    expect(seen).toEqual([]);

    sockets[0]!.fire('close');
    sockets[1]!.fire('open');
    expect(seen).toEqual([{ kind: 'reconnected' }]);
  });

  it('carries no ids on a reconnect — there is nothing in it to render', () => {
    const { sockets, factory } = factoryOf();
    const port = createWsPort({
      url: 'ws://x',
      factory,
      backoffMs: [1],
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });
    const seen: RealtimeEvent[] = [];
    port.subscribe((e) => seen.push(e));
    sockets[0]!.fire('open');
    sockets[0]!.fire('close');
    sockets[1]!.fire('open');
    expect(Object.keys(seen[0]!)).toEqual(['kind']);
  });

  it('a closed port stops reconnecting', () => {
    const { sockets, factory } = factoryOf();
    const port = createWsPort({
      url: 'ws://x',
      factory,
      backoffMs: [1],
      setTimeoutFn: (fn) => {
        fn();
        return 0;
      },
    });
    port.close();
    sockets[0]!.fire('close');
    expect(sockets).toHaveLength(1);
  });
});

describe('no transport means no realtime, and no broken screen (FR-014)', () => {
  it('an absent factory leaves the port inert and subscribable', () => {
    const port = createWsPort({ url: 'ws://x', factory: undefined as unknown as WsFactory });
    const off = port.subscribe(() => {
      throw new Error('nothing should arrive');
    });
    expect(typeof off).toBe('function');
    off();
  });

  it('an empty url (server render) opens nothing', () => {
    const { sockets, factory } = factoryOf();
    createWsPort({ url: '', factory });
    expect(sockets).toEqual([]);
  });
});
