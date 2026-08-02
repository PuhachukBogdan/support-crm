import { SESSION_STATE_KINDS, type SessionState } from './session';

/**
 * T010 [027] — `SessionState` has FOUR values, and every consumer must handle all four.
 *
 * ── Why four and not three ──────────────────────────────────────────────────────────────────────
 * The mock had two states plus a `ready` flag that flipped instantly, because the answer was local.
 * Against a real server the answer arrives over the network, and **a question that could not be
 * asked looks exactly like a negative answer** unless the model keeps them apart.
 *
 *   collapse `unreachable` into `anonymous` → a brief network blip signs out every agent, mid-ticket
 *   collapse it into `authenticated`        → a stranger sees protected chrome
 *
 * ⚠️ The union is exhaustive with **no default**. That is the FR-018 mechanism: the day the shape
 * changes, `tsc` lists every consumer instead of a boolean quietly compiling everywhere and being
 * wrong in the two places that matter. The 026 precedent is exact — a required parameter produced
 * five call sites where hand-reading had found two.
 */

/** Exhaustive by construction: adding a variant without a branch here fails `tsc --noEmit`. */
function describeState(state: SessionState): string {
  switch (state.kind) {
    case 'resolving':
      return 'holding';
    case 'authenticated':
      return `signed in as ${state.userId}`;
    case 'anonymous':
      return 'signed out';
    case 'unreachable':
      return 'cannot reach the service';
    default: {
      // If this stops compiling, a variant was added and some consumer was not told.
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

describe('SessionState — four values, not two', () => {
  it('declares exactly the four kinds', () => {
    expect([...SESSION_STATE_KINDS]).toEqual([
      'resolving',
      'authenticated',
      'anonymous',
      'unreachable',
    ]);
  });

  it('keeps "could not ask" separate from "the answer is no"', () => {
    // The whole point of the fourth state, asserted as behaviour rather than as a comment: these
    // two must never be the same value, because the guard does opposite things with them.
    const unreachable: SessionState = { kind: 'unreachable' };
    const anonymous: SessionState = { kind: 'anonymous' };

    expect(unreachable.kind).not.toBe(anonymous.kind);
    expect(describeState(unreachable)).not.toBe(describeState(anonymous));
  });

  it('carries the identity only on the authenticated variant', () => {
    // A `userId` that exists in every state invites reading it in a state where it means nothing.
    const authed: SessionState = {
      kind: 'authenticated',
      userId: 'u1',
      accountId: 'a1',
      roles: ['agent'],
    };
    expect(describeState(authed)).toBe('signed in as u1');
    expect(Object.keys({ kind: 'anonymous' } satisfies SessionState)).toEqual(['kind']);
  });

  it('every declared kind is handled — no variant reaches the default', () => {
    for (const kind of SESSION_STATE_KINDS) {
      const state = (kind === 'authenticated'
        ? { kind, userId: 'u', accountId: 'a', roles: [] }
        : { kind }) as SessionState;
      expect(describeState(state)).toEqual(expect.any(String));
    }
  });
});
