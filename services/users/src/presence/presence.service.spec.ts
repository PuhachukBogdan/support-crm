import { PresenceService } from './presence.service';
import { PresenceSweepService } from './presence-sweep.service';
import type { PresenceRepository } from './presence.repository';
import type { OperatorTransitionRecorder } from '../transition/transition.recorder';

/**
 * Feature 025 (roadmap 5.9) — the two requirements easiest to get subtly wrong.
 *
 *   • **FR-015** — a real change writes exactly ONE transition; a no-op writes NONE.
 *   • **FR-016** — the sweep only LOWERS; a heartbeat raises only what the sweep set.
 *
 * ── Why one file for repository, service, heartbeat and sweep ───────────────────────────────────
 * They share one fake store, and the properties under test are *relationships between them*: "the
 * sweep lowered me, so a heartbeat may raise me" is not a fact about either in isolation. Splitting
 * it across four files would mean four copies of the store and four chances for them to disagree
 * about what "already away" means.
 *
 * The fake reproduces what matters and nothing else: `forAccount` confines every operation to one
 * account, and `$transaction` runs the callback so a recorded transition is observable.
 */

interface Row {
  account_id: string;
  auth_user_id: string;
  state: string;
  last_cause: string | null;
  last_seen_at: Date | null;
  label_id: string | null;
}

function makeStore(rows: Row[] = [], operators = [{ account_id: 'acc-1', auth_user_id: 'u-1', id: 'op-1', active: true }]) {
  const transitions: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const repo = {
    async operatorFor(accountId: string, authUserId: string) {
      const o = operators.find((x) => x.account_id === accountId && x.auth_user_id === authUserId);
      return o ? { operatorId: o.id, active: o.active } : null;
    },
    async read(accountId: string, authUserId: string) {
      // ⚠️ A COPY, not the stored object. Prisma returns a fresh row per query, and a fake that
      // handed back a live reference would let `applyState` retroactively change what the caller had
      // already read — making the `from` of every transition equal its `to`. The first draft of this
      // file did exactly that and reported a product defect that did not exist.
      const found = rows.find((r) => r.account_id === accountId && r.auth_user_id === authUserId);
      return (
        (found ? { ...found } : undefined) ?? {
          auth_user_id: authUserId,
          state: 'offline',
          last_cause: null,
          last_seen_at: null,
          label_id: null,
        }
      );
    },
    async blockedChannels() {
      return new Map<string, string[]>();
    },
    async applyState(
      accountId: string,
      authUserId: string,
      next: { state: string; cause: string; labelId?: string | null },
      record: (tx: unknown) => unknown,
      recordAudit?: (tx: unknown) => unknown,
    ) {
      const existing = rows.find((r) => r.account_id === accountId && r.auth_user_id === authUserId);
      if (existing) {
        existing.state = next.state;
        existing.last_cause = next.cause;
        if (next.labelId !== undefined) existing.label_id = next.labelId;
      } else {
        rows.push({
          account_id: accountId,
          auth_user_id: authUserId,
          state: next.state,
          last_cause: next.cause,
          last_seen_at: null,
          label_id: next.labelId ?? null,
        });
      }
      await record({});
      // The audit entry rides the SAME transaction as the state change and the transition (FR-023).
      // The fake supplies a `tx` carrying an `auditEntry` delegate so that riding it is observable.
      if (recordAudit) await recordAudit({ auditEntry: { create: async (a: unknown) => { audits.push(a as Record<string, unknown>); } } });
    },
    async touch(accountId: string, authUserId: string, at: Date) {
      const existing = rows.find((r) => r.account_id === accountId && r.auth_user_id === authUserId);
      if (existing) existing.last_seen_at = at;
      else
        rows.push({
          account_id: accountId,
          auth_user_id: authUserId,
          state: 'offline',
          last_cause: null,
          last_seen_at: at,
          label_id: null,
        });
    },
    async idleSince(cutoff: Date, limit: number) {
      return rows
        .filter((r) => r.state !== 'offline' && r.last_seen_at !== null && r.last_seen_at < cutoff)
        .slice(0, limit);
    },
    async setChannelBlock() {
      /* not exercised here */
    },
  } as unknown as PresenceRepository;

  const recorder = {
    async record(_tx: unknown, input: Record<string, unknown>) {
      transitions.push(input);
    },
  } as unknown as OperatorTransitionRecorder;

  const service = new PresenceService(repo, recorder);
  const sweep = new PresenceSweepService(repo, service);
  return { service, sweep, rows, transitions, audits };
}

const at = (iso: string) => new Date(iso);

describe('⭐ FR-015 — exactly one record per real change, and none for a no-op', () => {
  it('a real change writes EXACTLY one transition', async () => {
    const { service, transitions } = makeStore();
    const out = await service.setState('acc-1', 'u-1', 'online', 'manual', { actorRef: 'u-1' });
    expect(out.status).toBe('ok');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'operator.presence_changed',
      subjectKind: 'operator',
      subjectId: 'u-1',
      payload: { from: 'offline', to: 'online', cause: 'manual' },
    });
  });

  it('⭐ setting the state it ALREADY holds writes ZERO transitions', async () => {
    // A no-op that recorded would inflate every future WFM figure at the source, and the inflation
    // would be invisible because each individual row would look perfectly correct.
    const { service, transitions } = makeStore([
      { account_id: 'acc-1', auth_user_id: 'u-1', state: 'away', last_cause: 'manual', last_seen_at: null, label_id: null },
    ]);
    const out = await service.setState('acc-1', 'u-1', 'away', 'manual', { actorRef: 'u-1' });
    expect(out.status).toBe('unchanged');
    expect(transitions).toHaveLength(0);
  });

  it('the payload carries ids and enums only — never a label’s text', async () => {
    const { service, transitions } = makeStore();
    await service.setState('acc-1', 'u-1', 'away', 'manual', { actorRef: 'u-1', labelId: 'lbl-1' });
    // `labelId` is stored on the ROW; it is deliberately absent from the payload, and the allow-list
    // would refuse a `label` key anyway. A label's NAME is operator-authored free text.
    expect(Object.keys(transitions[0]!.payload as object).sort()).toEqual(['cause', 'from', 'to']);
  });

  it('somebody with no operator profile is refused, not synthesised as offline', async () => {
    const { service, transitions } = makeStore([], []);
    const out = await service.setState('acc-1', 'ghost', 'online', 'manual', { actorRef: 'ghost' });
    expect(out.status).toBe('no_such_operator');
    expect(transitions).toHaveLength(0);
  });

  it('another account’s operator is indistinguishable from one that does not exist', async () => {
    const { service } = makeStore();
    expect((await service.read('acc-2', 'u-1')).status).toBe('no_such_operator');
  });
});

describe('⭐ FR-016 — the sweep lowers; a heartbeat raises only what the sweep set', () => {
  const idleRow = (cause: string | null, state = 'online'): Row => ({
    account_id: 'acc-1',
    auth_user_id: 'u-1',
    state,
    last_cause: cause,
    last_seen_at: at('2026-08-01T10:00:00Z'),
    label_id: null,
  });

  const THRESHOLDS = { awayAfterSeconds: 600, offlineAfterSeconds: 3600 };

  it('past the away threshold → away, recorded as AUTOMATIC', async () => {
    const { sweep, rows, transitions } = makeStore([idleRow('manual')]);
    const counts = await sweep.sweepIdle(50, at('2026-08-01T10:20:00Z'), THRESHOLDS);
    expect(counts).toMatchObject({ toAway: 1, toOffline: 0, failed: 0 });
    expect(rows[0]!.state).toBe('away');
    expect(transitions[0]).toMatchObject({
      actorKind: 'system',
      // A system actor names itself — `buildTransitionRow` refuses one that does not.
      actorRef: 'presence-sweep',
      payload: { from: 'online', to: 'away', cause: 'auto_inactivity' },
    });
  });

  it('⭐ past the OFFLINE threshold → offline in ONE step, not a chain', async () => {
    // Both thresholds are measured from last activity, so a long outage produces one transition for
    // the state actually entered rather than one per state passed through on paper.
    const { sweep, rows, transitions } = makeStore([idleRow('manual')]);
    const counts = await sweep.sweepIdle(50, at('2026-08-01T13:00:00Z'), THRESHOLDS);
    expect(counts).toMatchObject({ toAway: 0, toOffline: 1 });
    expect(rows[0]!.state).toBe('offline');
    expect(transitions).toHaveLength(1);
  });

  it('a second tick with no activity in between writes NOTHING', async () => {
    const { sweep, transitions } = makeStore([idleRow('manual')]);
    await sweep.sweepIdle(50, at('2026-08-01T10:20:00Z'), THRESHOLDS);
    const before = transitions.length;
    await sweep.sweepIdle(50, at('2026-08-01T10:21:00Z'), THRESHOLDS);
    expect(transitions).toHaveLength(before);
  });

  it('⭐ the sweep NEVER raises availability, from any starting state', async () => {
    for (const state of ['away', 'offline'] as const) {
      const { sweep, rows } = makeStore([idleRow('auto_inactivity', state)]);
      await sweep.sweepIdle(50, at('2026-08-01T10:20:00Z'), THRESHOLDS);
      // `away` may fall to `offline` at the wider cutoff, but nothing ever climbs.
      expect(['away', 'offline']).toContain(rows[0]!.state);
      expect(rows[0]!.state).not.toBe('online');
    }
  });

  it('a heartbeat raises from a state the SWEEP set', async () => {
    const { service, rows, transitions } = makeStore([
      { ...idleRow('auto_inactivity'), state: 'away' },
    ]);
    const out = await service.heartbeat('acc-1', 'u-1', at('2026-08-01T10:30:00Z'));
    expect(out.status).toBe('ok');
    expect(rows[0]!.state).toBe('online');
    expect(transitions).toHaveLength(1);
  });

  it('a heartbeat raises from the never-set default', async () => {
    const { service, rows } = makeStore();
    await service.heartbeat('acc-1', 'u-1', at('2026-08-01T10:30:00Z'));
    expect(rows[0]!.state).toBe('online');
  });

  it('⭐ a heartbeat does NOT undo what the person set themselves', async () => {
    // Somebody on "Lunch" with an open browser stays on lunch. The system does not get to decide
    // that a person's lunch is over.
    const { service, rows, transitions } = makeStore([{ ...idleRow('manual'), state: 'away' }]);
    const out = await service.heartbeat('acc-1', 'u-1', at('2026-08-01T10:30:00Z'));
    expect(out.status).toBe('unchanged');
    expect(rows[0]!.state).toBe('away');
    expect(transitions).toHaveLength(0);
  });

  it('⭐ a heartbeat does NOT undo a supervisor', async () => {
    // Otherwise the correction is reverted by the very stale session that made it necessary — and
    // the feature would not merely fail, it would look like it worked.
    const { service, rows, transitions } = makeStore([{ ...idleRow('admin'), state: 'offline' }]);
    await service.heartbeat('acc-1', 'u-1', at('2026-08-01T10:30:00Z'));
    expect(rows[0]!.state).toBe('offline');
    expect(transitions).toHaveLength(0);
  });

  it('a heartbeat always stamps activity, and stamping is NOT a transition', async () => {
    // 58 agents × once a minute. If a heartbeat recorded history, the stream would be almost
    // entirely made of "somebody's browser is still open".
    const { service, rows, transitions } = makeStore([{ ...idleRow('manual'), state: 'away' }]);
    await service.heartbeat('acc-1', 'u-1', at('2026-08-01T10:30:00Z'));
    expect(rows[0]!.last_seen_at).toEqual(at('2026-08-01T10:30:00Z'));
    expect(transitions).toHaveLength(0);
  });

  it('an operator who has never been active is not swept', async () => {
    // `last_seen_at: null` must not compare as "older than any cutoff" — they are already offline by
    // default, and inventing a transition for somebody who never started a shift would be a record
    // of something that did not happen.
    const { sweep, transitions } = makeStore([
      { account_id: 'acc-1', auth_user_id: 'u-1', state: 'online', last_cause: null, last_seen_at: null, label_id: null },
    ]);
    const counts = await sweep.sweepIdle(50, at('2026-08-01T23:00:00Z'), THRESHOLDS);
    expect(counts).toMatchObject({ toAway: 0, toOffline: 0 });
    expect(transitions).toHaveLength(0);
  });
});

describe('the supervisor override (US4) — the one presence act that is BOTH', () => {
  it('records cause `admin` and attributes the change to the CALLER, not the subject', async () => {
    const { service, transitions } = makeStore(
      [],
      [
        { account_id: 'acc-1', auth_user_id: 'u-1', id: 'op-1', active: true },
        { account_id: 'acc-1', auth_user_id: 'lead-1', id: 'op-2', active: true },
      ],
    );
    // Start them ONLINE: a supervisor setting `offline` on somebody already offline is a genuine
    // no-op, and asserting the payload of a transition that correctly never happened would be
    // testing the fixture rather than the feature.
    await service.setState('acc-1', 'u-1', 'online', 'manual', { actorRef: 'u-1' });
    await service.setState('acc-1', 'u-1', 'offline', 'admin', { actorRef: 'lead-1' });
    expect(transitions[1]).toMatchObject({
      // ⭐ The subject is the person whose presence changed; the actor is who changed it. Collapsing
      // the two would make "who put me offline?" unanswerable, which is the whole point of auditing
      // this act at all.
      subjectId: 'u-1',
      actorRef: 'lead-1',
      payload: { cause: 'admin' },
    });
  });

  it('⭐ writes EXACTLY one audit entry, in the same transaction (FR-023)', async () => {
    const { service, audits } = makeStore(
      [],
      [
        { account_id: 'acc-1', auth_user_id: 'u-1', id: 'op-1', active: true },
        { account_id: 'acc-1', auth_user_id: 'lead-1', id: 'op-2', active: true },
      ],
    );
    await service.setState('acc-1', 'u-1', 'online', 'manual', { actorRef: 'u-1' });
    expect(audits).toHaveLength(0); // ⭐ one's OWN presence is history, not a sensitive action

    await service.setState('acc-1', 'u-1', 'offline', 'admin', { actorRef: 'lead-1' });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({
      account_id: 'acc-1',
      action: 'presence.override',
      actor_user_id: 'lead-1',
      target_ref: 'u-1',
    });
  });

  it('the audit entry carries NO detail — the transition already says from/to/why', async () => {
    const { service, audits } = makeStore(
      [],
      [
        { account_id: 'acc-1', auth_user_id: 'u-1', id: 'op-1', active: true },
        { account_id: 'acc-1', auth_user_id: 'lead-1', id: 'op-2', active: true },
      ],
    );
    await service.setState('acc-1', 'u-1', 'online', 'manual', { actorRef: 'u-1' });
    await service.setState('acc-1', 'u-1', 'away', 'admin', { actorRef: 'lead-1' });
    // ⭐ The `privilege` class's detail allow-list is about PERMISSIONS (scope / permissionKey /
    // roleKey / grant / affectedCount). An override changes none, so there is nothing it may
    // legitimately carry — and the transition written in the same transaction already records
    // from/to/cause. Two stores, each answering its own question, neither duplicating the other.
    const detail = (audits[0]!.data as { detail_json?: unknown }).detail_json;
    expect(detail ?? null).toBeNull();
  });
});
