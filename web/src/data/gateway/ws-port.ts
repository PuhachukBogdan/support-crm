import type { RealtimeEvent } from '../data-access';

/**
 * The realtime transport (feature 034, MVP block W4).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⓘ **It lives here because it has to.** `no-direct-network.test.ts` forbids `new WebSocket(` anywhere
 * under `components/`, `app/` and `session/` — so the placement is enforced by a guard rather than chosen
 * by convention, exactly as `http-port.ts` is the one file allowed to call `fetch`.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
 * It carries no credential and builds no header. The browser sends the `httpOnly` access cookie with the
 * upgrade request by itself, and the gateway authorizes the handshake from it — which is the whole reason
 * the token is httpOnly: script cannot read it, so script cannot leak it, and it still authenticates.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface RealtimePort {
  subscribe(handler: (event: RealtimeEvent) => void): () => void;
}

const KINDS = new Set(['conversation.created', 'conversation.updated', 'message.created']);

/**
 * Parse a frame, or return `null`.
 *
 * ⚠️ **Unknown fields are DROPPED rather than passed through** — the third place this boundary is
 * re-asserted (the publisher builds it, the gateway re-parses it, and here it lands). Belt and braces on
 * purpose: this is the promise that a customer's words never reach a browser through the socket, and it
 * costs four lines to keep it true even if a server someday sends more.
 */
export function parseFrame(raw: string): RealtimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { event?: unknown; data?: unknown };
  if (envelope.event !== 'realtime') return null;
  const d = envelope.data as Record<string, unknown> | undefined;
  if (!d || typeof d.kind !== 'string' || !KINDS.has(d.kind)) return null;
  if (typeof d.accountId !== 'string' || typeof d.conversationId !== 'string') return null;
  const messageId = typeof d.messageId === 'string' ? d.messageId : undefined;
  return {
    kind: d.kind as 'conversation.created' | 'conversation.updated' | 'message.created',
    accountId: d.accountId,
    conversationId: d.conversationId,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

/** Injected so a test can drive the whole reconnect policy without a server or a timer. */
export interface WsFactory {
  (url: string): {
    addEventListener(type: 'message' | 'close' | 'open' | 'error', handler: (ev: unknown) => void): void;
    close(): void;
  };
}

export interface WsPortOptions {
  url?: string;
  factory?: WsFactory;
  /** Backoff schedule in ms. Injected so the reconnect test does not sleep. */
  backoffMs?: readonly number[];
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

/**
 * One socket for the whole app, shared by every subscriber.
 *
 * ⚠️ Deliberately **one**: a socket per component would open a dozen connections to the same account room
 * and deliver the same event a dozen times, so an event would trigger a dozen re-reads. The list of
 * handlers is what fans out, not the transport.
 */
export function createWsPort(options: WsPortOptions = {}): RealtimePort & { close(): void } {
  const handlers = new Set<(event: RealtimeEvent) => void>();
  const backoff = options.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 30_000];
  const schedule = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  let socket: ReturnType<WsFactory> | undefined;
  let attempt = 0;
  let stopped = false;
  let opened = false;

  /**
   * ⚠️⚠️ **`NEXT_PUBLIC_WS_ORIGIN` EXISTS BECAUSE THE FIRST HEADED CHECK FAILED ON EXACTLY THIS.**
   *
   * The first draft built the URL from `window.location.host` alone — the app's origin. But the socket
   * lives on the GATEWAY, whose port is loopback-bound (SEC-40), and Next's rewrite covers REST only: a
   * WebSocket upgrade is not a rewrite. So the browser dialled the Next server, which closed it, ten times
   * in a row, and received **0 frames** — while `live-w4.sh` was passing 13/13, because that socket dialled
   * the gateway directly inside the compose network. *Two halves, each verified alone.*
   *
   * ⚠️⚠️ **AND THE OVERRIDE CANNOT SOLVE IT, which the second headed check proved.** Pointed at
   * `ws://crm-gateway-1:3000/ws` the socket reached the right process and was closed 1008 twenty-seven times:
   * a browser sends a cookie only to the origin that set it, so a CROSS-ORIGIN socket carries no `access`
   * cookie and cannot be authorized. Cookie authentication and a foreign socket origin are mutually
   * exclusive — no configuration reconciles them.
   *
   * ⇒ **The socket must be SAME-ORIGIN, and the edge in front of the app must route `/ws` to the gateway.**
   * That is the only shape that works with an httpOnly session: one origin, one cookie, one certificate.
   * The override below therefore exists for one narrow case — a deployment whose socket origin sets its own
   * cookie (a different auth model, or a same-site subdomain) — and it is **not** the way to reach a gateway
   * on another host. Left in place with its limits written down, because deleting it would invite the next
   * person to add it back for the reason that does not work.
   */
  const origin = (process.env.NEXT_PUBLIC_WS_ORIGIN ?? '').trim();
  const url =
    options.url ??
    (origin !== ''
      ? `${origin.replace(/\/$/, '')}/ws`
      : typeof window === 'undefined'
        ? ''
        : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);

  const factory: WsFactory | undefined =
    options.factory ??
    (typeof WebSocket === 'undefined'
      ? undefined
      : ((u: string) => new WebSocket(u) as unknown as ReturnType<WsFactory>));

  function connect(): void {
    // ⓘ No transport (server render, or a jsdom without WebSocket) ⇒ the port is inert and every screen
    // behaves exactly as it does today. Realtime is an improvement, never a requirement (FR-014).
    if (stopped || !factory || url === '') return;
    /**
     * ⚠️⚠️ **CONSTRUCTING A SOCKET CAN THROW SYNCHRONOUSLY, AND IT TOOK THE WHOLE APP DOWN.**
     *
     * The operator opened the stand and got the shell's error screen:
     * `SecurityError: Failed to construct 'WebSocket': An insecure WebSocket connection may not be
     * initiated from a page loaded over HTTPS.` The URL was wrong (a stale build), but the wrong URL is not
     * the defect — **the defect is that a bad URL could break the product at all.** FR-014 says a socket
     * that cannot connect must leave the app behaving exactly as before; instead the throw propagated out
     * of the composition root and the page rendered nothing.
     *
     * ⇒ Every entry into the transport is contained. A realtime edge is an improvement, and an improvement
     * may not be able to break the thing it improves.
     */
    let ws;
    try {
      ws = factory(url);
    } catch {
      // No retry: a constructor that refuses is refusing the URL, and the next attempt would refuse it
      // identically. The app keeps working without live updates, which is the pre-034 behaviour.
      stopped = true;
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      attempt = 0;
      /**
       * ⚠️ Only a RE-connection notifies. A page that just loaded has already read, so announcing the first
       * connection would make every screen read twice on open — which is exactly the kind of "harmless"
       * duplicate that becomes a thundering herd when 58 agents open the app at shift change.
       *
       * `reconnected` carries no ids on purpose: there is nothing in it to render, so nobody can try
       * (FR-013).
       */
      if (opened) for (const handler of handlers) handler({ kind: 'reconnected' });
      opened = true;
    });
    ws.addEventListener('message', (ev: unknown) => {
      const data = (ev as { data?: unknown }).data;
      if (typeof data !== 'string') return;
      const event = parseFrame(data);
      if (!event) return;
      for (const handler of handlers) handler(event);
    });
    ws.addEventListener('close', () => {
      socket = undefined;
      if (stopped) return;
      // ⚠️ The gateway CLOSES a socket it cannot authorize, so a reconnect loop here is also the path a
      // client takes when its session expired — which is why the delay grows rather than hammering.
      const delay = backoff[Math.min(attempt, backoff.length - 1)]!;
      attempt += 1;
      schedule(() => connect(), delay);
    });
    ws.addEventListener('error', () => {
      // Nothing: an error is always followed by a close, and reacting to both would double the backoff.
    });
  }

  connect();

  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close() {
      stopped = true;
      socket?.close();
      handlers.clear();
    },
  };
}
