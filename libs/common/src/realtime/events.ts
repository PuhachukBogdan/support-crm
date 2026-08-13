/**
 * The realtime event vocabulary (feature 034, MVP block W4 — roadmap 7.1, subpoint 2.2a).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐⭐ **AN EVENT SAYS WHAT CHANGED, NEVER WHAT IT NOW SAYS.** The payload is a kind and one or two
 * ids. The client reacts by **re-reading through the REST path it already uses**, which is where every
 * read rule in this product lives.
 *
 * ── Why the payload is content-free, which is the whole design ───────────────────────────────────
 * A socket is a **second read path**, and it bypasses the checks on the REST routes unless every one of
 * them is repeated on it: account scoping (feature 007's client extension), server-side RBAC, the AM's
 * portfolio narrowing (026), field tiers and masking (SEC-AP1), and above all the **customer projection
 * that filters private notes AT THE QUERY** (feature 012). SEC-13 names the failure directly — a
 * realtime surface leaking private-note activity to a customer — and instructs that when one is built it
 * must *"reuse the query-level rule rather than filter in the UI"*.
 *
 * Carrying no content answers that at the root rather than by discipline: **there is no field on this
 * wire for a private note to travel in**, on any connection, now or when a customer-facing socket exists.
 * The projection stays the only authority on who may see what, and the socket cannot drift from it
 * because it never answers the question.
 *
 * ⚠️ **The cost, named rather than hidden:** one extra REST round-trip per event, and a client that
 * ignores an event shows stale data — exactly as it does today. Both are acceptable; a leak is not.
 *
 * ⚠️ **What an id alone still reveals:** *that something changed*. A conversation id is useless without
 * the read that is already authorized, but volume is a signal — which is why every publish is to an
 * account channel and there is deliberately **no global broadcast** ({@link realtimeChannel}).
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The closed set. A new kind is a deliberate addition here, not a string invented at a call site — the
 * same rule every other catalogue in this repo follows (permissions, audit actions, upload purposes,
 * export scopes, status categories, channel kinds).
 */
export const REALTIME_EVENT_KINDS = [
  /** A conversation now exists that did not before — from any channel, or created by an agent. */
  'conversation.created',
  /** Something about the conversation ROW changed: status, assignee, brand, priority, labels. */
  'conversation.updated',
  /** A message was added to a conversation — inbound from a customer or outbound from an agent. */
  'message.created',
] as const;

export type RealtimeEventKind = (typeof REALTIME_EVENT_KINDS)[number];

/**
 * ⚠️ **THIS SHAPE IS THE SECURITY BOUNDARY.** Four fields, all of them identifiers.
 *
 * No body, no subject, no author name, no address, no status label, no counts, and **no index signature
 * or `extras` bag** — a shape that cannot grow by accident. `tests/realtime/payload-shape.spec.ts`
 * fails the build if it does, because *"just add the subject, it's convenient"* is exactly how a
 * notification becomes an unauthorized read.
 *
 * `accountId` is here for ROUTING and is never rendered: the gateway uses it to pick the room, and the
 * client already knows which account it is signed in to.
 */
export interface RealtimeEvent {
  readonly kind: RealtimeEventKind;
  readonly accountId: string;
  readonly conversationId: string;
  /** Present only on `message.created` — the id to re-read, never the message itself. */
  readonly messageId?: string;
}

/** The exact set of keys a payload may carry. Read by the structural guard, not only by humans. */
export const REALTIME_PAYLOAD_KEYS = ['kind', 'accountId', 'conversationId', 'messageId'] as const;

/**
 * The one channel-name builder — **and the reason there is no variant without an account.**
 *
 * Tenant isolation is this block's invariant, and the cheapest way to keep it is to make a
 * tenant-less channel unexpressible: no `realtimeBroadcastChannel()`, no optional parameter, no
 * default. A guard asserts every publish call site goes through this function.
 */
export function realtimeChannel(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed === '') {
    // Fail closed and loudly. An empty account would produce ONE shared channel that every socket in
    // every tenant could plausibly be joined to — the worst possible outcome of a silent default.
    throw new Error('realtimeChannel requires an account');
  }
  return `crm:rt:acct:${trimmed}`;
}

/** Narrowing helper for the subscriber side: an unrecognised kind is ignored, never guessed at. */
export function isRealtimeEventKind(value: unknown): value is RealtimeEventKind {
  return typeof value === 'string' && (REALTIME_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Parse a frame received from Redis into an event, or `null`.
 *
 * ⚠️ **Unknown fields are DROPPED, not passed through.** The gateway forwards what this returns, so a
 * publisher that someday adds `subject` cannot have it reach a browser: the boundary re-asserts itself on
 * the way out as well as on the way in. Defence in depth for the one property the whole design rests on.
 */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (!isRealtimeEventKind(o.kind)) return null;
  if (typeof o.accountId !== 'string' || o.accountId === '') return null;
  if (typeof o.conversationId !== 'string' || o.conversationId === '') return null;
  const messageId = typeof o.messageId === 'string' && o.messageId !== '' ? o.messageId : undefined;
  return {
    kind: o.kind,
    accountId: o.accountId,
    conversationId: o.conversationId,
    ...(messageId === undefined ? {} : { messageId }),
  };
}
