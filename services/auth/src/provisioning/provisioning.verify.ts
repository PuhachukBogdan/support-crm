import { createHash } from 'node:crypto';
import { isAddressAllowed, verifySignature } from '@crm/common';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §5/§6 — SEC-PV1): the gate every provisioning call
 * passes before anything in the product hears about it.
 *
 * ── The order is the design, not a style ────────────────────────────────────────────────────────
 * key → address → signature → rate → idempotency. Each step is cheaper than the next and each one
 * narrows who can make us do the following one:
 *   · **key first** because everything after it is per-key configuration — there is no allow-list to
 *     consult and no rate to count until we know whose key this is;
 *   · **address before signature** because an address check is a string compare while a signature is
 *     an HMAC: a flood from an unlisted address must not cost us a digest each (the same reasoning
 *     the channel verifier applies to its replay window, one layer down);
 *   · **rate before idempotency** because the rate limit exists to bound WORK, and claiming an
 *     idempotency row is a write;
 *   · **idempotency last** because it is the only step that mutates anything, so every deterministic
 *     refusal has already happened and a refused call leaves no claim behind.
 *
 * ── Every refusal is a VALUE, never an exception ────────────────────────────────────────────────
 * ADR 0043 §5 requires every call audited «including rejected ones». A thrown error is something a
 * caller can forget to catch; a returned verdict is something the caller must destructure — and the
 * one call site writes an audit row for whatever it destructures. That is why this module cannot
 * write the audit itself: it is pure, and purity is what makes it testable without a database.
 *
 * Pure functions, no I/O. The repository lookups are passed in.
 */

/** Why a call was refused. A CLOSED vocabulary — the audit detail's `reasonClass` is exactly this. */
export type ProvisioningRefusal =
  | 'malformed' // no idempotency key, unparsable signature header, body that is not an object
  | 'unknown_key' // no such key id
  | 'revoked_key' // the key exists and was switched off
  | 'signature' // digest mismatch — a wrong secret and an altered body are indistinguishable
  | 'stale' // signature outside the replay window
  | 'ip' // caller's address is not on this key's list
  | 'rate' // over the key's hourly cap
  | 'forbidden_role'; // the resolved target is an administrator — see the least-privilege note below

/**
 * ⚠️ **The status a refusal renders as.** `unknown_key` and `revoked_key` deliberately produce the
 * SAME 401 as a bad signature: a revoked key that answered 403 while an invented one answered 401
 * would let a caller enumerate which credentials ever existed. The distinction survives only in the
 * audit trail, where it is read by us and not by the caller.
 */
export const REFUSAL_STATUS: Readonly<Record<ProvisioningRefusal, number>> = {
  malformed: 400,
  unknown_key: 401,
  revoked_key: 401,
  signature: 401,
  stale: 401,
  ip: 403,
  rate: 429,
  forbidden_role: 403,
};

/** The problem type suffix (RFC-7807 style), rendered by the edge under our namespace. */
export const REFUSAL_TYPE: Readonly<Record<ProvisioningRefusal, string>> = {
  malformed: 'bad-request',
  unknown_key: 'unauthorized',
  revoked_key: 'unauthorized',
  signature: 'unauthorized',
  stale: 'unauthorized',
  ip: 'forbidden',
  rate: 'rate-limited',
  forbidden_role: 'forbidden',
};

export interface ApiKeyFacts {
  id: string;
  accountId: string;
  consumer: string;
  fingerprint: string;
  secretHash: string;
  ipAllowList: readonly string[];
  ratePerHour: number;
  active: boolean;
}

export interface VerifyInput {
  keyId: string;
  keySecret: string;
  signatureHeader: string | undefined;
  rawBody: string;
  clientIp: string | undefined;
  idempotencyKey: string | undefined;
  receivedAt: number;
  replayWindowSeconds: number;
}

export interface VerifyDeps {
  /** null when no such key exists in any account — the caller must not learn which. */
  findKey: (keyId: string) => Promise<ApiKeyFacts | null>;
  /** argon2 verify; never throws (the token service's helper). */
  verifySecret: (secretHash: string, secret: string) => Promise<boolean>;
  /** Accepted AND refused calls for this key in the trailing hour — a durable count. */
  countRecentCalls: (keyId: string) => Promise<number>;
}

export type VerifyVerdict =
  | { ok: true; key: ApiKeyFacts; idempotencyKey: string; bodyHash: string }
  | { ok: false; refusal: ProvisioningRefusal; key: ApiKeyFacts | null };

/** The digest stored alongside a claim, so a retry with a different body is a conflict (ADR §6). */
export function hashBody(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

/**
 * The salted digest of an HR employee id, for the audit trail.
 *
 * ⚠️ The trail must let an investigator confirm «was this person provisioned» without letting anyone
 * READ an employee number out of it — the W9 `valueHash` precedent, verbatim reasoning. The salt is
 * the account id: two accounts hashing the same HR id produce different digests, so the trail of one
 * tenant cannot be used as a rainbow table for another.
 */
export function hashEmployeeId(accountId: string, hrEmployeeId: string): string {
  return createHash('sha256').update(`${accountId}:${hrEmployeeId}`, 'utf8').digest('hex');
}

export async function verifyProvisioningCall(
  input: VerifyInput,
  deps: VerifyDeps,
): Promise<VerifyVerdict> {
  // 0. Shape. An absent idempotency key is malformed rather than «generate one»: ADR 0043 §6 makes
  //    it required precisely so a retry is the caller's decision to declare, not ours to guess.
  const idempotencyKey = (input.idempotencyKey ?? '').trim();
  if (!input.keyId || !input.keySecret || !idempotencyKey) {
    return { ok: false, refusal: 'malformed', key: null };
  }

  // 1. Whose key is this?
  const key = await deps.findKey(input.keyId);
  if (!key) return { ok: false, refusal: 'unknown_key', key: null };
  if (!key.active) return { ok: false, refusal: 'revoked_key', key };

  // 2. Is this caller allowed to hold it? (Fail-closed: an empty list denies — @crm/common.)
  if (!isAddressAllowed(input.clientIp, key.ipAllowList)) {
    return { ok: false, refusal: 'ip', key };
  }

  // 3. Does the secret match, and does the signature cover these exact bytes?
  //    ⚠️ The secret is verified BEFORE the signature so that a valid-looking signature computed
  //    with a guessed secret costs the attacker an argon2 verification, not us an HMAC — and so the
  //    two failures stay indistinguishable to the caller (both 'signature').
  const secretOk = await deps.verifySecret(key.secretHash, input.keySecret);
  if (!secretOk) return { ok: false, refusal: 'signature', key };

  const verdict = verifySignature({
    header: input.signatureHeader,
    rawBody: input.rawBody,
    secret: input.keySecret,
    receivedAt: input.receivedAt,
    replayWindowSeconds: input.replayWindowSeconds,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      refusal: verdict.refusal === 'stale' ? 'stale' : verdict.refusal === 'malformed' ? 'malformed' : 'signature',
      key,
    };
  }

  // 4. Has this key had enough for one hour? Counted durably from rows that already exist — an
  //    in-memory counter resets on deploy, and a cap that resets is not a cap (the export-quota
  //    reasoning, and the contact-lookup precedent of auditing the refusal too).
  const recent = await deps.countRecentCalls(key.id);
  if (recent >= key.ratePerHour) return { ok: false, refusal: 'rate', key };

  return { ok: true, key, idempotencyKey, bodyHash: hashBody(input.rawBody) };
}
