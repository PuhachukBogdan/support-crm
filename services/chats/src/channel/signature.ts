import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification (feature 033, roadmap 6.5 — FR-009, SEC-C2/C3).
 *
 * ── Why this lives in chats and not at the gateway ──────────────────────────────────────────────
 * The secret belongs to a channel, and channels are chats' data. The gateway does routing and JWT
 * validation and holds no business logic (Principle VIII); a per-tenant shared secret is tenant
 * configuration, not transport authentication like a JWT. Verifying there would mean either a second
 * secret store or shipping a symmetric key to a service with no other use for it.
 *
 * ── The scheme, and why this one ────────────────────────────────────────────────────────────────
 * `X-CRM-Signature: t=<unix-seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
 * Chosen because it is the shape third parties already know how to produce (Stripe, GitHub). The
 * timestamp is signed rather than merely sent, so it cannot be edited in transit to widen the window.
 *
 * ── ⚠️ THE REPLAY WINDOW IS NOT THE DUPLICATE SUPPRESSOR ────────────────────────────────────────
 * It bounds **forgery**: a captured body must not stay replayable for ever. Duplicate suppression is the
 * unique constraint on `(channel_id, external_event_id)`. The two are constantly conflated, and the
 * result of conflating them is a system that accepts a duplicate once it is old enough — so a stale
 * delivery is refused as stale rather than waved through as new.
 */

/** Why verification failed. A CLASS — never a sentence, and never anything derived from the secret. */
export type SignatureRefusal =
  /** No signature at all, or a header that does not parse. */
  | 'malformed'
  /** Parsed, but the digest does not match. Covers a wrong secret AND an altered body: we cannot tell
   *  which, and must not guess — telling an attacker which half they got right is the whole game. */
  | 'mismatch'
  /** Outside the window. Structurally valid, and refused. */
  | 'stale';

export type SignatureVerdict = { ok: true } | { ok: false; refusal: SignatureRefusal };

export interface ParsedSignature {
  timestamp: number;
  digest: string;
}

/**
 * Parse `t=<unix>,v1=<hex>`.
 *
 * Order-insensitive and tolerant of spaces, because a header assembled by somebody else's code is not
 * ours to dictate the whitespace of. Unknown parts are ignored rather than rejected: a provider adding
 * `v2=` for a future scheme must not break the one we understand.
 */
export function parseSignatureHeader(header: string | undefined): ParsedSignature | null {
  if (!header) return null;
  let timestamp: number | undefined;
  let digest: string | undefined;

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === 'v1') {
      // Hex only. A digest with other characters cannot be ours, and letting it through would put
      // attacker-controlled text into a comparison.
      if (/^[0-9a-f]+$/i.test(value)) digest = value.toLowerCase();
    }
  }

  return timestamp !== undefined && digest !== undefined ? { timestamp, digest } : null;
}

/** The signed string. Exported so a test — and `live-w3.sh` — can produce one the same way. */
export function signingInput(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function computeDigest(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(signingInput(timestamp, rawBody)).digest('hex');
}

export interface VerifyInput {
  header: string | undefined;
  rawBody: string;
  secret: string | undefined;
  /** Unix seconds, from the gateway's clock at receipt. */
  receivedAt: number;
  replayWindowSeconds: number;
}

/**
 * Verify a delivery.
 *
 * ⚠️ **An absent secret is a `mismatch`, not a pass.** A channel whose secret is not configured cannot
 * be verified, so nothing it sends may be accepted — the fail-closed direction, and the reason
 * `parseChannelSecrets` drops a malformed entry rather than admitting an empty secret.
 */
export function verifySignature(input: VerifyInput): SignatureVerdict {
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, refusal: 'malformed' };
  if (!input.secret) return { ok: false, refusal: 'mismatch' };

  // Window checked BEFORE the digest: an expired signature is refused whether or not it verifies, and
  // doing the cheap check first means a flood of stale replays costs no HMACs.
  const skew = Math.abs(input.receivedAt - parsed.timestamp);
  if (skew > input.replayWindowSeconds) return { ok: false, refusal: 'stale' };

  const expected = Buffer.from(computeDigest(input.secret, parsed.timestamp, input.rawBody), 'utf8');
  const given = Buffer.from(parsed.digest, 'utf8');
  // ⚠️ Length-checked first: `timingSafeEqual` THROWS on differing lengths. Letting that throw would
  // turn a malformed digest into a 500 — an availability bug reachable by anybody who can post here.
  if (expected.length !== given.length) return { ok: false, refusal: 'mismatch' };
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, refusal: 'mismatch' };
}
