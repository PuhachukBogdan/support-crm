import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { Redis } from 'ioredis';
import { parseRealtimeEvent, realtimeChannel } from '@crm/common';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';
import { ACCESS_COOKIE } from '../auth/session-cookie';
import { verifyAccessToken } from '../auth/verify-access-token';
import { RedisService } from '../redis/redis.service';

/** The subset of a `ws` socket this gateway uses. Kept narrow so a test double is three lines. */
interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close', handler: () => void): void;
}

/**
 * The realtime edge (feature 034, MVP block W4 — roadmap 7.1, subpoint 2.2a).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **THE GLOBAL AUTH GUARD DOES NOT PROTECT THIS.** `AuthGuard.canActivate` opens with
 * `if (context.getType() !== 'http') return true;` and its own comment says *"Non-HTTP contexts
 * (WebSocket) are out of scope here and pass through"*. So before this file, the socket surface was
 * **completely unauthenticated** — which is why the plan calls a socket *"a second read path that bypasses
 * the checks on the REST routes unless they are repeated"*, and means it literally.
 *
 * Authorization therefore happens HERE, at the handshake, using `verifyAccessToken` — the **same**
 * function the HTTP guard uses, not a second copy of it. Two verifiers drift, and the weaker one is the
 * one that gets used.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── What this gateway is, and what it deliberately is not ────────────────────────────────────────
 * It is a **fan-out**: it forwards an event to the sockets of the account that event belongs to, and it
 * **adds nothing**. It holds no chats client, performs no read, and enriches no payload — and that absence
 * is the security property, not an omission. The moment this file fetches a subject "because it has the
 * conversation id right there", the socket becomes a read path and inherits every rule the REST projection
 * enforces (account scope, RBAC, the AM's portfolio narrowing, field tiers, and the private-note filter
 * SEC-13 exists for). `realtime.gateway.spec.ts` asserts the frame equals the published payload.
 *
 * ── Rooms are the ACCOUNT, and the account comes from the token ──────────────────────────────────
 * ⚠️ There is **no frame vocabulary for joining anything**. A client cannot ask for an account, a
 * conversation or a filter, because no handler accepts one — which is a stronger guarantee than validating
 * such a request would be. Tenant isolation is this block's invariant and it rests on a value the client
 * never supplies.
 *
 * ── Subscribing per account rather than to a pattern ─────────────────────────────────────────────
 * A `psubscribe('crm:rt:acct:*')` would be shorter and would make this pod receive every tenant's events
 * whether anybody is watching or not. Subscribing on the first socket of an account and unsubscribing on
 * the last keeps the traffic proportional to who is actually connected — and keeps an idle deployment
 * genuinely idle.
 *
 * ⓘ The subscriber is a **duplicate** connection: an ioredis client in subscribe mode may not run ordinary
 * commands, and `RedisService.client` is already the readiness probe's.
 */
@Injectable()
/**
 * ⚠️ **AN EXPLICIT PATH, added after the headed browser check (2026-08-05).** The socket used to accept the
 * root path, which is unproxyable: whatever fronts the app cannot tell a page request from an upgrade
 * without matching headers. `/ws` is a path a reverse proxy can route on its own — which is what the
 * hosted stand needs, since the gateway's port is loopback-bound (SEC-40) and a browser can only ever
 * reach it through the edge.
 */
@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  /** account id → the sockets watching it. The only routing table. */
  private readonly rooms = new Map<string, Set<Socket>>();
  private readonly accountOf = new WeakMap<Socket, string>();
  private subscriber?: Redis;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  /**
   * ⚠️ **A socket that cannot be authorized is CLOSED, not left open and silent.**
   *
   * An idle-but-connected socket is indistinguishable, from the client's side, from "nothing is happening"
   * — so a client whose cookie expired would sit for ever believing it was up to date. Closing makes the
   * client's reconnect-and-re-read path the thing that runs (FR-013), which is exactly the recovery
   * behaviour wanted.
   */
  handleConnection(client: Socket, request?: IncomingMessage): void {
    const claims = verifyAccessToken(this.jwt, this.cfg.JWT_SECRET, cookieOf(request, ACCESS_COOKIE));
    if (!claims) {
      // 1008 = policy violation. No reason string: a client learns nothing from "expired" that it cannot
      // learn by trying to refresh, and the difference is a hint worth withholding.
      client.close(1008);
      return;
    }
    this.join(claims.accountId, client);
    client.on('close', () => this.leave(client));
  }

  /**
   * ⚠️ **`ping` LIVES HERE, and it had to move.** It was its own `@WebSocketGateway` class, and when both
   * declared `path: '/ws'` the handshake was closed with `handleConnection` never running — two gateway
   * classes on one path do not compose under the native `ws` adapter; the adapter binds one, and the ping
   * class has no connection handler. Measured on the stand: the gateway logged nothing at all.
   *
   * ⓘ It still earns its place: spec 003's US4 claim is that REST and realtime answer on the SAME port, and
   * this reply is the only thing that demonstrates it. One class, one path, one authorization.
   */
  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: unknown): { event: 'pong'; data: unknown } {
    return { event: 'pong', data: data ?? null };
  }

  handleDisconnect(client: Socket): void {
    this.leave(client);
  }

  private join(accountId: string, client: Socket): void {
    let room = this.rooms.get(accountId);
    if (!room) {
      room = new Set();
      this.rooms.set(accountId, room);
      // First watcher for this account ⇒ start listening for it.
      //
      // ⚠️ The `.catch` is not decoration. Without it an unreachable Redis turns every connection into an
      // UNHANDLED PROMISE REJECTION — found by the ingress integration test, which boots the real module
      // against a Redis that is not there and printed `Error: Connection is closed.` after passing. Under
      // Node's default that is a process-level crash, so the gateway would die from a downed cache while
      // every REST route it serves was still perfectly healthy.
      void this.subscribeTo(accountId);
    }
    room.add(client);
    this.accountOf.set(client, accountId);
  }

  private leave(client: Socket): void {
    const accountId = this.accountOf.get(client);
    if (!accountId) return;
    this.accountOf.delete(client);
    const room = this.rooms.get(accountId);
    if (!room) return;
    room.delete(client);
    if (room.size === 0) {
      this.rooms.delete(accountId);
      // Nobody left watching ⇒ stop paying for the traffic. Same reasoning as `join`: a failure here is a
      // wasted subscription, never a crashed gateway.
      void this.unsubscribeFrom(accountId);
    }
  }

  /**
   * Both halves of the subscription, with their failures contained.
   *
   * A Redis that is down means **no live updates**, which is a degradation the client already handles (it
   * re-reads on its own reconnect). It must never mean a gateway that stops serving REST.
   */
  private async subscribeTo(accountId: string): Promise<void> {
    try {
      const sub = await this.channel();
      await sub?.subscribe(realtimeChannel(accountId));
    } catch {
      // The class would add nothing here: there is exactly one thing that can go wrong (Redis is not
      // reachable) and the readiness probe already reports it.
      this.logger.warn('realtime: could not subscribe — live updates are off for now');
    }
  }

  private async unsubscribeFrom(accountId: string): Promise<void> {
    try {
      const sub = await this.channel();
      await sub?.unsubscribe(realtimeChannel(accountId));
    } catch {
      // Nothing to report: nobody is watching this account any more either way.
    }
  }

  /** The one subscriber connection, built on first need. */
  private async channel(): Promise<Redis | undefined> {
    if (this.subscriber) return this.subscriber;
    const sub = this.redis.client.duplicate();
    sub.on('error', () => undefined);
    sub.on('message', (channel: string, payload: string) => this.deliver(channel, payload));
    this.subscriber = sub;
    return sub;
  }

  /**
   * Forward one event to its own room.
   *
   * ⚠️ **The account is taken from the PARSED EVENT and matched against the room, and the frame is sent
   * unchanged.** Two properties in one method:
   *
   *  · `parseRealtimeEvent` drops any field it does not know, so a publisher that someday adds a subject
   *    cannot have it reach a browser — the boundary re-asserts itself on the way out (FR-001).
   *  · the room is keyed by the account from the **token** at handshake, so an event can only ever reach
   *    sockets of the account it names. Cross-tenant delivery is not filtered, it is unrepresentable.
   */
  private deliver(channel: string, payload: string): void {
    const event = parseRealtimeEvent(payload);
    if (!event) {
      // A frame we cannot read is dropped, never guessed at or forwarded raw.
      this.logger.warn('realtime: unreadable event dropped');
      return;
    }
    if (channel !== realtimeChannel(event.accountId)) {
      // ⭐ The channel and the payload disagree about the tenant. Nothing legitimate produces this, so it
      // is refused rather than resolved in either direction — picking one would be choosing which of two
      // untrusted claims to trust.
      this.logger.warn('realtime: event dropped — channel and payload disagree on the account');
      return;
    }
    const room = this.rooms.get(event.accountId);
    if (!room) return;
    const frame = JSON.stringify({ event: 'realtime', data: event });
    for (const socket of room) {
      try {
        socket.send(frame);
      } catch {
        // A dead socket is dropped from the room rather than allowed to break the loop for the others.
        this.leave(socket);
      }
    }
  }

  onModuleDestroy(): void {
    this.subscriber?.disconnect();
  }
}

/**
 * Read one cookie off the upgrade request.
 *
 * ⚠️ Parsed here by hand because `cookie-parser` is Express middleware and an upgrade request never passes
 * through the HTTP middleware chain — the kind of gap that makes a "just read `req.cookies`" implementation
 * silently see nothing and refuse every connection.
 */
function cookieOf(request: IncomingMessage | undefined, name: string): string | undefined {
  const header = request?.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
