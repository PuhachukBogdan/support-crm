import {
  SIGN_IN_OUTCOME_KINDS,
  CODE_OUTCOME_KINDS,
  INVITE_START_OUTCOME_KINDS,
  INVITE_COMPLETE_OUTCOME_KINDS,
  OUTCOME_KIND_SETS,
  type SignInOutcome,
  type CodeOutcome,
} from './session';

/**
 * T011 [027] — the outcome vocabulary is the product's, not HTTP's.
 *
 * Two properties, both from `contracts/session-port.md`:
 *
 * 1. **`unreachable` is a variant of every outcome, not an exception.** A thrown error is easy to
 *    catch generically and report as "wrong password" — which is FR-014's defect exactly. Making it
 *    a value the compiler forces you to handle is the difference between a rule and a hope.
 * 2. **No outcome carries a status code.** `423` means nothing on a screen; `locked` does. It also
 *    means the day a status changes, one file changes.
 *
 * ⭐ `bad_code` deliberately carries no reason. The interface decides *expired* from `codeExpiresAt`,
 * which it already holds (FR-012). A reason here would invite somebody to make the server supply
 * one, reopening a security decision that was made deliberately and belongs to whoever owns it.
 */

/** Exhaustive by construction — the mechanism, applied to the outcomes as well as to the state. */
function messageFor(outcome: SignInOutcome): string {
  switch (outcome.kind) {
    case 'code_sent':
      return 'we sent you a code';
    case 'rejected':
      return 'those details were not accepted';
    case 'locked':
      return 'this account is locked';
    case 'unreachable':
      return 'we could not reach the service';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

describe('the outcome unions', () => {
  it('every outcome union carries an unreachable variant', () => {
    for (const [name, kinds] of Object.entries(OUTCOME_KIND_SETS)) {
      expect(`${name}:${kinds.includes('unreachable')}`).toBe(`${name}:true`);
    }
  });

  it('declares the kinds the contract names', () => {
    expect([...SIGN_IN_OUTCOME_KINDS]).toEqual(['code_sent', 'rejected', 'locked', 'unreachable']);
    expect([...CODE_OUTCOME_KINDS]).toEqual(['ok', 'bad_code', 'unreachable']);
    expect([...INVITE_START_OUTCOME_KINDS]).toEqual(['code_sent', 'rejected', 'unreachable']);
    expect([...INVITE_COMPLETE_OUTCOME_KINDS]).toEqual([
      'ok',
      'weak_password',
      'rejected',
      'unreachable',
    ]);
  });

  it('no outcome kind is an HTTP status or names one', () => {
    // The failure this prevents is a screen switching on `401` — which would put the gateway's
    // status vocabulary into the UI, where a status change becomes a UI change.
    for (const kinds of Object.values(OUTCOME_KIND_SETS)) {
      for (const kind of kinds) {
        expect(kind).not.toMatch(/^\d+$/);
        expect(kind).not.toMatch(/status|http|code_4|401|403|422|423/i);
      }
    }
  });

  it('⭐ bad_code carries no reason — the interface decides expired from the clock it holds', () => {
    const bad: CodeOutcome = { kind: 'bad_code' };
    expect(Object.keys(bad)).toEqual(['kind']);
    // …and the union offers no richer variant to reach for.
    expect(CODE_OUTCOME_KINDS).not.toContain('expired_code');
  });

  it('rejection does not distinguish an unknown address from a wrong password', () => {
    // FR-011: separating them is account enumeration. Asserted on the vocabulary, because that is
    // where the distinction would have to exist in order to be shown.
    expect(SIGN_IN_OUTCOME_KINDS).not.toContain('unknown_email');
    expect(SIGN_IN_OUTCOME_KINDS).not.toContain('wrong_password');
    expect(messageFor({ kind: 'rejected' })).toBe('those details were not accepted');
  });

  it('locked stays distinguishable, because the server distinguishes it', () => {
    // The opposite call from the one above, and the reason is not symmetry — it is that flattening
    // `locked` back into `rejected` hides the one fact the person actually needs.
    expect(messageFor({ kind: 'locked' })).not.toBe(messageFor({ kind: 'rejected' }));
  });
});
