import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseIpAllowList } from '@crm/common';
import { TokenService } from '../auth/token.service';
import { CLOCK, type Clock } from '../auth/ports/clock';
import { AuditRepository } from '../audit/audit.repository';
import { ApiKeysRepository, type ApiKeyRow, type NewApiKey } from './api-keys.repository';

/**
 * The provisioning key's lifecycle (W31 / feature 038, roadmap 3.17 — ADR 0043 §5, SEC-PV1).
 *
 * ── The value exists for one response and nowhere else ──────────────────────────────────────────
 * `<id>.<secret>` is assembled here, returned once, and never reconstructible: at rest there is an
 * argon2id hash of the secret half, exactly as `Invitation.token_hash` and `RefreshToken.token_hash`
 * already work. That is why «I lost the key» is answered by rotation and not by a lookup — and why
 * the model has no column a forgotten filter could leak.
 *
 * ── There is no logging in this file, deliberately ──────────────────────────────────────────────
 * FR-020 asks for a structural guarantee rather than a review habit. The cheapest structure is a
 * module that never acquired a logger: no line to redact, no formatter to get right, nothing to
 * accidentally interpolate a `value` into.
 *
 * ── The fingerprint is a LABEL, not a digest of the secret ──────────────────────────────────────
 * `fp_` + first 12 hex of `sha256("<id>:<secret>")`. Not the secret's hash (that would put a
 * searchable derivative of the credential in the trail and on the screen); not the id alone (two
 * lineage generations of one consumer would be indistinguishable). Short, stable, non-reversible —
 * enough to answer «is the key on the screen the key in the journal». The prefix earns its place
 * below.
 */

/** The server's cap when the caller states none — mirrors the schema default. */
export const DEFAULT_RATE_PER_HOUR = 60;

/** A consumer name is an operator's words, not prose; the audit detail layer caps values at 120 too. */
const MAX_CONSUMER_LENGTH = 120;

export interface IssuedKey {
  key: ApiKeyRow;
  /** `<id>.<secret>` — the ONLY place this string is ever produced. */
  value: string;
}

export interface IssueInput {
  consumer: string;
  ipAllowList?: string[];
  ratePerHour?: number;
}

export type IssueOutcome =
  | { status: 'ok'; issued: IssuedKey }
  | { status: 'invalid' }
  | { status: 'consumer_taken' };

export type RotateOutcome =
  | { status: 'ok'; issued: IssuedKey }
  | { status: 'not_found' }
  | { status: 'already_revoked' };

export type RevokeOutcome = { status: 'ok'; revoked: boolean } | { status: 'not_found' };

/**
 * Why a verification failed. ⚠️ The CALLER of this method must collapse `unknown_key` and
 * `revoked_key` into one refusal on the wire (FR-008): a revoked key that answers differently from a
 * key that never existed is an oracle. The reasons are separated HERE because the journal has the
 * opposite need — «somebody is still using the key we killed» is the entry an incident is looking for.
 */
export type VerifyFailure = 'unknown_key' | 'revoked_key' | 'mismatch';

export type VerifyResult = { ok: true; key: ApiKeyFacts } | { ok: false; reason: VerifyFailure };

/**
 * What a VERIFIER may know about a key: enough to decide, nothing more.
 *
 * ⚠️ Declared here rather than imported from the machine path, so the dependency runs the right way
 * — the key module owns what a key is, and the provisioning verifier states the port it needs and
 * takes this shape structurally. `secretHash` is a hash and never a value; there is no value to put
 * here even if somebody wanted one.
 */
export interface ApiKeyFacts {
  id: string;
  accountId: string;
  consumer: string;
  fingerprint: string;
  secretHash: string;
  ipAllowList: string[];
  ratePerHour: number;
  active: boolean;
}

const toFacts = (row: ApiKeyRow): ApiKeyFacts => ({
  id: row.id,
  accountId: row.account_id,
  consumer: row.consumer,
  fingerprint: row.fingerprint,
  secretHash: row.secret_hash,
  ipAllowList: [...(row.ip_allow_list ?? [])],
  ratePerHour: row.rate_per_hour,
  active: row.active,
});

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(ApiKeysRepository) private readonly keys: ApiKeysRepository,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(accountId: string): Promise<ApiKeyRow[]> {
    return this.keys.list(accountId);
  }

  async issue(accountId: string, actorUserId: string, input: IssueInput): Promise<IssueOutcome> {
    const consumer = (input.consumer ?? '').trim();
    if (!consumer || consumer.length > MAX_CONSUMER_LENGTH) return { status: 'invalid' };

    const material = await this.mint({
      consumer,
      ipAllowList: input.ipAllowList,
      ratePerHour: input.ratePerHour,
      createdBy: actorUserId,
    });

    // Built BEFORE the transaction opens: `statement()` validates eagerly, so an inexpressible entry
    // refuses the issuance instead of being rolled back afterwards (feature 015).
    const entry = this.audit.statement(accountId, {
      action: 'api_key.issued',
      actorUserId,
      targetRef: material.row.id,
      detail: { keyFingerprint: material.row.fingerprint },
    });

    try {
      await this.keys.insert(accountId, material.row, entry);
    } catch (err) {
      // P2002 on `ApiKey_one_active_per_consumer`: this consumer already holds a live key. Refused
      // rather than silently making a second one — «revoke the HR key» must have one answer.
      if ((err as { code?: string })?.code === 'P2002') return { status: 'consumer_taken' };
      throw err;
    }

    return { status: 'ok', issued: await this.issuedFrom(accountId, material) };
  }

  /**
   * Replace a live key: the predecessor stops working at the moment the successor is shown.
   *
   * ⚠️ ONE audit entry (`api_key.rotated`), not a revoke plus an issue — the reader's question is
   * «when did this consumer's credential change», and two rows invite the answer «twice» (catalogue).
   * The lineage is `rotated_from_id`, so «which key was live last Tuesday» still has an answer.
   */
  async rotate(accountId: string, actorUserId: string, keyId: string): Promise<RotateOutcome> {
    const previous = await this.keys.byId(accountId, keyId);
    if (!previous) return { status: 'not_found' };
    // Rotation replaces a LIVE credential. Re-arming a revoked consumer is an issuance and says so —
    // otherwise «rotate» would quietly become the way to undo a revocation.
    if (!previous.active) return { status: 'already_revoked' };

    const material = await this.mint({
      consumer: previous.consumer,
      ipAllowList: previous.ip_allow_list,
      ratePerHour: previous.rate_per_hour,
      createdBy: actorUserId,
      rotatedFromId: previous.id,
    });

    const entry = this.audit.statement(accountId, {
      action: 'api_key.rotated',
      actorUserId,
      // The SUCCESSOR is the target: it is the row that exists afterwards, and its `rotated_from_id`
      // names the predecessor, so one entry reaches both ends of the lineage.
      targetRef: material.row.id,
      detail: { keyFingerprint: material.row.fingerprint },
    });

    await this.keys.rotate(accountId, previous.id, material.row, entry);
    return { status: 'ok', issued: await this.issuedFrom(accountId, material) };
  }

  /** Immediate, and repeatable: a second revocation answers `revoked: false` rather than failing. */
  async revoke(accountId: string, actorUserId: string, keyId: string): Promise<RevokeOutcome> {
    const existing = await this.keys.byId(accountId, keyId);
    if (!existing) return { status: 'not_found' };
    if (!existing.active) return { status: 'ok', revoked: false };

    const entry = this.audit.statement(accountId, {
      action: 'api_key.revoked',
      actorUserId,
      targetRef: existing.id,
      detail: { keyFingerprint: existing.fingerprint },
    });

    const changed = await this.keys.revoke(accountId, existing.id, entry);
    return { status: 'ok', revoked: changed > 0 };
  }

  /**
   * Is this `<id>.<secret>` a live key?
   *
   * The secret is verified BEFORE the active flag is read, so a caller holding the wrong secret for a
   * revoked key is reported as a mismatch rather than being told the key exists and is dead. The id
   * itself is public by construction — it travels in `X-CRM-Key` on every call — so the existence of
   * a row is not the thing being protected here; the secret is.
   *
   * `verifyPassword` never throws: a malformed stored hash is a non-match, not a 500.
   */
  async verify(keyId: string, secret: string): Promise<VerifyResult> {
    // Composed from the two halves below rather than repeating them: one lookup path and one argon2
    // path in this service, two entry points onto them.
    const facts = await this.factsFor(keyId);
    if (!facts) return { ok: false, reason: 'unknown_key' };
    if (!(await this.verifySecret(facts.secretHash, secret))) return { ok: false, reason: 'mismatch' };
    if (!facts.active) return { ok: false, reason: 'revoked_key' };
    return { ok: true, key: facts };
  }

  /**
   * ⭐ W31 / 038: the two halves of `verify` above, exposed separately for the provisioning gate.
   *
   * ── Why the gate does not call `verify` ─────────────────────────────────────────────────────────
   * `verify` answers one question («is this a live key»), which is the right shape for a caller that
   * only needs a yes. The provisioning gate needs the ORDER: it checks the caller's address before
   * it spends an argon2 verification, so a flood from an unlisted address costs a string compare
   * rather than a KDF each. That requires reading the key's facts first and verifying the secret
   * afterwards — the same two operations, in the order the boundary needs them.
   *
   * ⚠️ The distinction stays OURS: `unknown_key` and `revoked_key` are separate reasons in the audit
   * trail and the same 401 to the caller (`provisioning.verify.ts`'s REFUSAL_STATUS). Reading the
   * facts here never tells the caller anything.
   */
  async factsFor(keyId: string): Promise<ApiKeyFacts | null> {
    const id = (keyId ?? '').trim();
    if (!id) return null;
    const row = await this.keys.resolve(id);
    return row ? toFacts(row) : null;
  }

  /** argon2 verification, alone. Never throws — a malformed stored hash is a non-match, not a 500. */
  async verifySecret(secretHash: string, secret: string): Promise<boolean> {
    return this.tokens.verifyPassword(secretHash, secret ?? '');
  }

  /** Call this on ACCEPTED calls only — `last_used_at` is «the key worked», not «somebody tried». */
  async markUsed(keyId: string): Promise<void> {
    await this.keys.markUsed(keyId, this.clock.now());
  }

  /**
   * Generate the material for one key. The id is minted HERE rather than by the database default
   * because the fingerprint is derived from it and the audit entry has to name it — on a create there
   * is no row yet to read either from (the channel-admin precedent).
   */
  private async mint(input: {
    consumer: string;
    ipAllowList?: readonly string[];
    ratePerHour?: number;
    createdBy: string;
    rotatedFromId?: string;
  }): Promise<{ row: NewApiKey; value: string }> {
    const id = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const secretHash = await this.tokens.hashPassword(secret);
    const rate = Math.floor(input.ratePerHour ?? 0);
    return {
      row: {
        id,
        consumer: input.consumer,
        secretHash,
        fingerprint: fingerprintOf(id, secret),
        // ⚠️ EMPTY DENIES EVERYTHING (`@crm/common` ip-allow-list, fail-closed). Normalised on the
        // way in so the stored list and the runtime comparison cannot drift.
        ipAllowList: parseIpAllowList(input.ipAllowList ?? []),
        ratePerHour: rate > 0 ? rate : DEFAULT_RATE_PER_HOUR,
        createdBy: input.createdBy,
        rotatedFromId: input.rotatedFromId ?? null,
      },
      value: `${id}.${secret}`,
    };
  }

  /** Read the row back so the caller answers with what was stored, not with what was intended. */
  private async issuedFrom(
    accountId: string,
    material: { row: NewApiKey; value: string },
  ): Promise<IssuedKey> {
    const stored = await this.keys.byId(accountId, material.row.id);
    return { key: stored ?? asRow(accountId, material.row), value: material.value };
  }
}

/**
 * Short, non-reversible label. See the module banner for why it is not the secret's own hash.
 *
 * ⚠️ **The `fp_` prefix is load-bearing, not decoration.** The audit detail layer refuses a value
 * that is entirely digits as «a bare number» (personal-data guard, `libs/common/src/audit/detail.ts`),
 * and one hex string in ~220 is all digits — so a bare digest would have refused roughly half a
 * percent of issuances, at random, long after this shipped. A prefix that always carries a letter
 * makes the value an identifier by construction. Found by a test run, not by review.
 */
export function fingerprintOf(id: string, secret: string): string {
  return `fp_${createHash('sha256').update(`${id}:${secret}`).digest('hex').slice(0, 12)}`;
}

/** Fallback shape when the read-back is unavailable — the same fields, none of them the value. */
function asRow(accountId: string, key: NewApiKey): ApiKeyRow {
  return {
    id: key.id,
    account_id: accountId,
    consumer: key.consumer,
    secret_hash: key.secretHash,
    fingerprint: key.fingerprint,
    ip_allow_list: key.ipAllowList,
    rate_per_hour: key.ratePerHour,
    active: true,
    rotated_from_id: key.rotatedFromId ?? null,
    last_used_at: null,
    created_by: key.createdBy,
    created_at: new Date(),
    updated_at: new Date(),
  };
}
