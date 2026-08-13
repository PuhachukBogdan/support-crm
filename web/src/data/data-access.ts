import type { Query, PaginatedResult, ResourceName } from './types';

/**
 * The typed, transport-agnostic data boundary (the "C" contract). Screens and composites
 * depend ONLY on this interface — never on `src/api` or `fetch`. Implementations are
 * interchangeable: MockDataAccess (now) and GatewayDataAccess (later), swapped behind
 * DataAccessProvider with no consumer change (SC-001).
 */
export interface DataAccess {
  list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>>;
  get<T = unknown>(resource: ResourceName, id: string): Promise<T>;
  create<T = unknown>(resource: ResourceName, input: unknown): Promise<T>;
  update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T>;
  remove(resource: ResourceName, id: string): Promise<void>;
  /**
   * Watch for *something changed*, and re-read through the methods above (feature 034, MVP block W4).
   *
   * ── ⭐ Why this widens THIS port instead of adding a second one ───────────────────────────────────
   * A socket is a second network path, and `no-direct-network.test.ts` already forbids
   * `new WebSocket(` in `components/`, `app/` and `session/` — its own note records the argument for
   * *widening one port rather than adding a second*: the guard then keeps covering every path. A separate
   * realtime context would be a network dependency the seam does not know about, and the last transport
   * that lived outside the seam was `gotchas/wired-only-in-tests`.
   *
   * ── ⚠️ AN EVENT CARRIES NO CONTENT, SO A CONSUMER MUST RE-READ ───────────────────────────────────
   * The handler receives a kind and one or two ids and nothing else — no subject, no body, no address.
   * That is deliberate and load-bearing: every read rule this product has (account scope, RBAC, the AM's
   * portfolio narrowing, field tiers, and the private-note filter SEC-13 exists for) lives on the read
   * path, so anything pushed would have to repeat all of them. **Merge nothing from the event; ask again.**
   *
   * Returns the unsubscribe function. An implementation with no transport returns a no-op, and a screen
   * behaves exactly as it does today — realtime is an improvement, never a requirement.
   */
  subscribe(handler: (event: RealtimeEvent) => void): () => void;
}

/**
 * What the socket delivers — the same four identifiers `@crm/common` defines for the server side, restated
 * here because `web/` deliberately imports nothing from the services' shared library.
 *
 * ⚠️ No optional extras, no index signature: the type is the promise that a customer's words never reach a
 * browser through this path, and `realtime-payload.test.ts` fails the build if it grows.
 */
export type RealtimeEvent =
  | {
      readonly kind: 'conversation.created' | 'conversation.updated' | 'message.created';
      readonly accountId: string;
      readonly conversationId: string;
      readonly messageId?: string;
    }
  /**
   * ⭐ **A LOCAL kind the server never sends.** The socket dropped and came back, so the interval it was
   * down for is exactly when events were missed — "connected again" is not "up to date" (FR-013).
   *
   * It is a member of this union rather than a second subscription because every consumer's reaction is
   * identical (*re-read*), and a separate `onReconnected` channel would be a second thing for each screen
   * to remember to wire. ⚠️ It carries **no ids**, which is what makes it impossible to mistake for a
   * server event: there is nothing in it to render, so nobody can try.
   */
  | { readonly kind: 'reconnected' };

export type { ResourceName } from './types';
