import { RECOVERY_REASONS, isRecoveryReason } from './recovery-reasons';
import { AuditDetailError, parseDetail } from '../audit/detail';
import { actionsOfClass } from '../audit/catalogue';

/**
 * W36 / 041 — the recovery reason vocabulary, and the property that makes it worth having: it is the ONLY
 * place the truth exists, because the product tells a stranger the same thing whatever happened.
 */
describe('the vocabulary is closed, and every member is EXPRESSIBLE in the trail', () => {
  it('every reason passes the audit detail guard under `reasonClass`', () => {
    // The point of recording a CLASS rather than a value: there is no member of this set, and no
    // combination of them, that the personal-data guard could refuse.
    for (const reason of RECOVERY_REASONS) {
      expect(parseDetail('recovery.requested', { reasonClass: reason })).toEqual({ reasonClass: reason });
      expect(parseDetail('recovery.refused', { reasonClass: reason })).toEqual({ reasonClass: reason });
    }
  });

  it('⛔ …while an ADDRESS remains inexpressible under the same key — the negative control', () => {
    // If this ever stopped throwing, the trail would have grown the hole FR-001 exists to prevent.
    expect(() => parseDetail('recovery.requested', { reasonClass: 'ivan@example.com' })).toThrow(
      AuditDetailError,
    );
  });

  it('the salted hash of an address IS expressible, and a raw one is not', () => {
    const hash = 'a'.repeat(64); // the shape a sha256 has: hex, no `@`, no dialling run
    expect(parseDetail('recovery.requested', { valueHash: hash })).toEqual({ valueHash: hash });
    expect(() => parseDetail('recovery.requested', { valueHash: 'ivan@example.com' })).toThrow(
      AuditDetailError,
    );
  });

  it('the revoked-session count is a NUMBER, so «signed out everywhere» has a bound to show', () => {
    expect(parseDetail('password.changed', { revokedCount: 3 })).toEqual({ revokedCount: 3 });
  });

  it('⛔ no key exists for the token, the password, or which policy rule failed', () => {
    for (const key of ['token', 'password', 'newPassword', 'failures', 'email']) {
      expect(() => parseDetail('recovery.completed', { [key]: 'x' } as never)).toThrow(AuditDetailError);
    }
  });

  it('the four actions of the class all accept the class’s keys', () => {
    for (const action of actionsOfClass('authentication')) {
      expect(parseDetail(action, { reasonClass: 'ok', revokedCount: 1 })).toEqual({
        reasonClass: 'ok',
        revokedCount: 1,
      });
    }
  });

  it('the type guard admits exactly the vocabulary', () => {
    expect(isRecoveryReason('unknown_address')).toBe(true);
    expect(isRecoveryReason('ok')).toBe(true);
    expect(isRecoveryReason('because he asked')).toBe(false);
    expect(isRecoveryReason(undefined)).toBe(false);
  });

  it('names the four cases a requester is deliberately NOT told apart', () => {
    // The set that FR-001 flattens into one answer. Pinned so a future edit that adds a fifth has to
    // decide whether the fixed response still covers it.
    for (const hidden of ['unknown_address', 'no_password', 'inactive', 'rate_capped']) {
      expect(RECOVERY_REASONS).toContain(hidden);
    }
  });
});
