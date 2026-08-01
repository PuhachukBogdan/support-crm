import { buildTransitionRow, TransitionTypeError } from './row';

/**
 * T009 (feature 025, roadmap 5.9 — FR-004). The shared row builder.
 *
 * Its own behaviour was already covered by `services/chats/src/transition/transition.recorder.spec.ts`
 * before the move, and that suite still passes **with no edit** — which is the real proof the move
 * was a move. This file adds what only makes sense once there are TWO writers: that the envelope is
 * the same regardless of which service is shaping it.
 */

const base = {
  accountId: 'acc-1',
  occurredAt: new Date('2026-08-01T10:00:00.000Z'),
  actorKind: 'user' as const,
  actorRef: 'user-1',
  dims: {},
  correlationId: 'corr-1',
};

describe('buildTransitionRow — one envelope for every writer', () => {
  it('shapes a chats-owned transition and a users-owned one into the SAME column set', () => {
    // ⭐ The point of the whole exercise. The B2 aggregate store reads one logical stream; two
    // writers emitting different columns would mean it must know both shapes, permanently.
    const fromChats = buildTransitionRow({
      ...base,
      type: 'conversation.status_changed',
      subjectKind: 'conversation',
      subjectId: 'conv-1',
      payload: { from: 'open', to: 'pending' },
    });
    const fromUsers = buildTransitionRow({
      ...base,
      type: 'operator.presence_changed',
      subjectKind: 'operator',
      subjectId: 'user-9',
      payload: { from: 'online', to: 'away', cause: 'auto_inactivity' },
    });

    expect(Object.keys(fromChats).sort()).toEqual(Object.keys(fromUsers).sort());
    expect(Object.keys(fromUsers).sort()).toEqual([
      'account_id',
      'actor_kind',
      'actor_ref',
      'correlation_id',
      'dims_json',
      'id',
      'occurred_at',
      'payload_json',
      'subject_id',
      'subject_kind',
      'type',
    ]);
  });

  it('generates a distinct id per row', () => {
    const a = buildTransitionRow({ ...base, type: 'operator.presence_changed', subjectKind: 'operator', subjectId: 's', payload: { from: 'online', to: 'away', cause: 'manual' } });
    const b = buildTransitionRow({ ...base, type: 'operator.presence_changed', subjectKind: 'operator', subjectId: 's', payload: { from: 'online', to: 'away', cause: 'manual' } });
    expect(a.id).not.toBe(b.id);
  });

  it('an absent actor_ref is stored as null, and absent dims stay an empty object', () => {
    // Absent vs null matters downstream: a null dimension would claim the dimension existed and was
    // empty. `dims_json` is passed through untouched so the caller decides what is absent.
    const row = buildTransitionRow({
      ...base,
      actorRef: undefined,
      type: 'operator.presence_changed',
      subjectKind: 'operator',
      subjectId: 's',
      payload: { from: 'online', to: 'away', cause: 'manual' },
    });
    expect(row.actor_ref).toBeNull();
    expect(row.dims_json).toEqual({});
  });
});

describe('the three refusals travelled with the function', () => {
  it('refuses an unknown type WITHOUT echoing it', () => {
    // The type is caller input when invalid; echoing it into a message is the feature-021 mistake.
    try {
      buildTransitionRow({ ...base, type: 'operator.went_for_a_walk', subjectKind: 'operator', subjectId: 's' });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionTypeError);
      expect(String((err as Error).message)).not.toContain('went_for_a_walk');
    }
  });

  it('refuses a payload key the allow-list does not permit', () => {
    // ⭐ The presence type allows from/to/cause and nothing else. A session id, a device name or a
    // label's TEXT are unexpressible here — which is the enforcement FR-037 points at, rather than
    // an intention to be careful.
    expect(() =>
      buildTransitionRow({
        ...base,
        type: 'operator.presence_changed',
        subjectKind: 'operator',
        subjectId: 's',
        payload: { from: 'online', to: 'away', cause: 'manual', sessionId: 'sess-1' },
      }),
    ).toThrow();
  });

  it('refuses a system actor that does not name itself', () => {
    // "Something happened, by nobody" is the entry that makes a trail useless six months later —
    // and the sweep is precisely a system actor, so this refusal is live in this feature.
    expect(() =>
      buildTransitionRow({
        ...base,
        actorKind: 'system',
        actorRef: undefined,
        type: 'operator.presence_changed',
        subjectKind: 'operator',
        subjectId: 's',
        payload: { from: 'online', to: 'away', cause: 'auto_inactivity' },
      }),
    ).toThrow(/must name itself/);
  });

  it('accepts a system actor that DOES name itself', () => {
    // The positive control: the refusal above must not be passing because the call fails anyway.
    const row = buildTransitionRow({
      ...base,
      actorKind: 'system',
      actorRef: 'presence-sweep',
      type: 'operator.presence_changed',
      subjectKind: 'operator',
      subjectId: 's',
      payload: { from: 'online', to: 'away', cause: 'auto_inactivity' },
    });
    expect(row.actor_ref).toBe('presence-sweep');
  });
});
