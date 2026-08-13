import { computeDigest } from '@crm/common';
import {
  verifyProvisioningCall,
  hashBody,
  hashEmployeeId,
  REFUSAL_STATUS,
  type ApiKeyFacts,
} from './provisioning.verify';

/**
 * ⭐ W31 / 038 — the gate (ADR 0043 §5/§6, SEC-PV1).
 *
 * The three properties worth a test each, because each one is a way the surface could be wrong
 * while looking right: the ORDER (a cheap refusal must not cost an expensive check), the SAMENESS
 * (a revoked key must be indistinguishable from an invented one), and the FAIL-CLOSED default (a key
 * whose addresses were never configured refuses everything).
 */

const SECRET = 'a'.repeat(64);
const NOW = 1_760_000_000;

const key = (over: Partial<ApiKeyFacts> = {}): ApiKeyFacts => ({
  id: 'key-1',
  accountId: 'acc-1',
  consumer: 'HR platform',
  fingerprint: 'fp-abc123',
  secretHash: 'argon2-of-the-secret',
  ipAllowList: ['203.0.113.7'],
  ratePerHour: 60,
  active: true,
  ...over,
});

const sign = (body: string, secret = SECRET, t = NOW) => `t=${t},v1=${computeDigest(secret, t, body)}`;

const deps = (over: Partial<Parameters<typeof verifyProvisioningCall>[1]> = {}, k: ApiKeyFacts | null = key()) => ({
  findKey: jest.fn(async () => k),
  verifySecret: jest.fn(async (_hash: string, secret: string) => secret === SECRET),
  countRecentCalls: jest.fn(async () => 0),
  ...over,
});

const call = (over: Record<string, unknown> = {}) => ({
  keyId: 'key-1',
  keySecret: SECRET,
  signatureHeader: sign('{"hrEmployeeId":"E-1"}'),
  rawBody: '{"hrEmployeeId":"E-1"}',
  clientIp: '203.0.113.7',
  idempotencyKey: 'idem-1',
  receivedAt: NOW,
  replayWindowSeconds: 300,
  ...over,
});

describe('the happy path', () => {
  it('accepts a signed call from an allowed address and hands back the claim material', async () => {
    const d = deps();
    const verdict = await verifyProvisioningCall(call(), d);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.key.id).toBe('key-1');
    expect(verdict.idempotencyKey).toBe('idem-1');
    expect(verdict.bodyHash).toBe(hashBody('{"hrEmployeeId":"E-1"}'));
  });
});

describe('*** the refusal matrix — every branch is a value, never a throw ***', () => {
  it.each([
    ['no idempotency key', { idempotencyKey: '' }, 'malformed'],
    ['a stale signature', { receivedAt: NOW + 600 }, 'stale'],
    ['a body that was not the signed one', { rawBody: '{"hrEmployeeId":"E-2"}' }, 'signature'],
    ['a caller not on the list', { clientIp: '198.51.100.9' }, 'ip'],
    ['no caller address at all', { clientIp: undefined }, 'ip'],
  ])('%s ⇒ %s', async (_name, over, expected) => {
    const verdict = await verifyProvisioningCall(call(over), deps());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal).toBe(expected);
  });

  it('a wrong secret reads as `signature` — never as «wrong password»', async () => {
    const verdict = await verifyProvisioningCall(call({ keySecret: 'b'.repeat(64) }), deps());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal).toBe('signature');
  });

  it('over the hourly cap ⇒ rate', async () => {
    const verdict = await verifyProvisioningCall(call(), deps({ countRecentCalls: jest.fn(async () => 60) }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal).toBe('rate');
  });
});

describe('*** ⭐ a revoked key is indistinguishable from one that never existed ***', () => {
  it('both answer 401, and only the trail can tell them apart', async () => {
    const unknown = await verifyProvisioningCall(call(), deps({}, null));
    const revoked = await verifyProvisioningCall(call(), deps({}, key({ active: false })));
    expect(unknown.ok).toBe(false);
    expect(revoked.ok).toBe(false);
    if (unknown.ok || revoked.ok) return;
    // Different reasons for US, identical status for THEM — otherwise a caller can enumerate which
    // credentials once existed by reading status codes.
    expect(unknown.refusal).toBe('unknown_key');
    expect(revoked.refusal).toBe('revoked_key');
    expect(REFUSAL_STATUS[unknown.refusal]).toBe(REFUSAL_STATUS[revoked.refusal]);
    expect(REFUSAL_STATUS[unknown.refusal]).toBe(401);
  });
});

describe('*** ⭐ fail-closed: a key with no configured addresses refuses everything ***', () => {
  it('an empty allow-list denies even a perfectly signed call', async () => {
    const verdict = await verifyProvisioningCall(call(), deps({}, key({ ipAllowList: [] })));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal).toBe('ip');
  });
});

describe('*** ⭐ the ORDER is the design: a cheap refusal never pays for an expensive check ***', () => {
  it('an unlisted address costs no signature verification and no rate query', async () => {
    const d = deps();
    await verifyProvisioningCall(call({ clientIp: '198.51.100.9' }), d);
    expect(d.verifySecret).not.toHaveBeenCalled();
    expect(d.countRecentCalls).not.toHaveBeenCalled();
  });

  it('an unknown key costs nothing beyond the lookup', async () => {
    const d = deps({}, null);
    await verifyProvisioningCall(call(), d);
    expect(d.verifySecret).not.toHaveBeenCalled();
    expect(d.countRecentCalls).not.toHaveBeenCalled();
  });

  it('a rate refusal happens BEFORE anything is claimed (the verdict carries no claim)', async () => {
    const verdict = await verifyProvisioningCall(call(), deps({ countRecentCalls: jest.fn(async () => 999) }));
    expect(verdict.ok).toBe(false);
    // A refused call must leave no idempotency row behind — expressed here as: the verdict hands
    // the caller nothing to claim with.
    expect(verdict).not.toHaveProperty('idempotencyKey');
  });
});

describe('the trail-safe digests', () => {
  it('an employee id is salted per account — one tenant’s trail is not a table for another', () => {
    const a = hashEmployeeId('acc-1', 'E-10422');
    const b = hashEmployeeId('acc-2', 'E-10422');
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
    expect(a).not.toContain('E-10422');
  });

  it('a body hash identifies a retry without storing the body (it carries an email)', () => {
    expect(hashBody('{"a":1}')).toBe(hashBody('{"a":1}'));
    expect(hashBody('{"a":1}')).not.toBe(hashBody('{"a":2}'));
    expect(hashBody('{"email":"ivan@company.test"}')).not.toContain('@');
  });
});
