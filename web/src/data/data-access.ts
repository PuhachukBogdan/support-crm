import type { Query, PaginatedResult, ResourceName } from './types';

/**
 * The typed, transport-agnostic data boundary (the "C" contract). Screens and composites
 * depend ONLY on this interface — never on `src/api` or `fetch`. Implementations are
 * interchangeable: MockDataAccess (now) and GatewayDataAccess (later), swapped behind
 * DataAccessProvider with no consumer change (SC-001).
 */
export interface DataAccess {
  list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>>;
  /**
   * `within` (W9): the parent instance for a CHILD read — same rule as the writes below.
   * `filters` (W10): declared query parameters for a single-record read (the contact summary
   * REQUIRES `brandId`). Same allow-list as a list's: undeclared keys are refused, not dropped.
   */
  get<T = unknown>(
    resource: ResourceName,
    id: string,
    within?: string,
    filters?: Record<string, unknown>,
  ): Promise<T>;
  /**
   * W7 widened the three writes with `within` — the parent instance id for CHILD resources
   * (`conversation-messages` lives under one conversation). Reads carry it on `Query.within`
   * instead, so `list` is unchanged. Optional and additive: every pre-W7 implementation and call
   * site is untouched, and a `within` against a non-child row is refused, never ignored.
   */
  create<T = unknown>(resource: ResourceName, input: unknown, within?: string): Promise<T>;
  update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T>;
  /**
   * W9 widened the return: a DELETE may answer with a body worth reading — detaching a player
   * returns what staff wrote while it was attached (ADR 0044 §5's warning). Callers that ignore it
   * are unchanged; `void` remains the default type parameter.
   */
  remove<T = void>(resource: ResourceName, id: string, within?: string): Promise<T>;
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
