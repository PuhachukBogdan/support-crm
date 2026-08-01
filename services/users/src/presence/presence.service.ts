import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Metadata } from '@grpc/grpc-js';
import {
  buildEntry,
  isLowerAvailability,
  mayHeartbeatRaise,
  type PresenceCause,
  type PresenceState,
} from '@crm/common';
import { PresenceRepository, type PresenceRow } from './presence.repository';
import { OperatorTransitionRecorder } from '../transition/transition.recorder';
import { buildOperatorDims } from '../transition/transition.dims';

/**
 * Presence, the decisions (feature 025, roadmap 5.9).
 *
 * The repository stores; this decides **whether** a write happens at all — which is where the two
 * requirements that are easiest to get subtly wrong live:
 *
 *   • **FR-015** — a real change writes exactly one transition; a no-op writes NONE. A no-op that
 *     recorded would inflate every future WFM figure at the source, and the inflation would be
 *     invisible because each individual row would look correct.
 *   • **FR-016** — the sweep only ever LOWERS availability, and a heartbeat may raise it only from a
 *     state the sweep itself set. See `mayHeartbeatRaise` in `@crm/common` for why the two refusals
 *     (a person's own "Lunch"; a supervisor's correction) matter more than the permission.
 */

export type PresenceOutcome =
  | { status: 'ok'; presence: PresenceRow }
  | { status: 'unchanged'; presence: PresenceRow }
  | { status: 'no_such_operator' }
  | { status: 'forbidden' };

@Injectable()
export class PresenceService {
  constructor(
    @Inject(PresenceRepository) private readonly repo: PresenceRepository,
    @Inject(OperatorTransitionRecorder) private readonly transitions: OperatorTransitionRecorder,
  ) {}

  /** One person's presence, as the read surface reports it. */
  async read(accountId: string, authUserId: string): Promise<PresenceOutcome> {
    const operator = await this.repo.operatorFor(accountId, authUserId);
    // ⚠️ NOT a synthesised `offline`. Somebody with no operator profile is not a member of staff,
    // and answering "offline" would be a claim about a person the product does not employ.
    if (!operator) return { status: 'no_such_operator' };
    return { status: 'ok', presence: await this.repo.read(accountId, authUserId) };
  }

  /** Set one's own presence, or (via `cause: 'admin'`) somebody else's. */
  async setState(
    accountId: string,
    authUserId: string,
    state: PresenceState,
    cause: PresenceCause,
    options: { labelId?: string | null; actorRef: string; metadata?: Metadata } ,
  ): Promise<PresenceOutcome> {
    const operator = await this.repo.operatorFor(accountId, authUserId);
    if (!operator) return { status: 'no_such_operator' };

    const current = await this.repo.read(accountId, authUserId);
    const labelUnchanged =
      options.labelId === undefined || (options.labelId ?? null) === current.label_id;

    // ⭐ FR-015. Setting a state to the value already held writes ZERO transitions. The label is part
    // of the comparison because changing only the displayed word is also not a state change — but it
    // still has to be persisted, which is why `unchanged` is returned only when BOTH match.
    if (current.state === state && labelUnchanged) {
      return { status: 'unchanged', presence: current };
    }

    await this.write(accountId, authUserId, current, state, cause, {
      labelId: options.labelId,
      actorKind: 'user',
      actorRef: options.actorRef,
      metadata: options.metadata,
      // ⭐ FR-023. The ONE presence act that is both history and a sensitive action. Own-presence
      // changes pass `false` and write no entry — a statement about oneself is not a sensitive act,
      // and auditing every toggle would bury the entries that matter under ~58 agents × several a day.
      audited: cause === 'admin',
    });

    return { status: 'ok', presence: await this.repo.read(accountId, authUserId) };
  }

  /**
   * The activity signal.
   *
   * Always stamps `last_seen_at`; raises the state only when FR-016 permits. The stamp is not a
   * transition — an activity timestamp is not a change of state, and recording one per heartbeat
   * would be 58 agents × once a minute of history that says nothing.
   */
  async heartbeat(
    accountId: string,
    authUserId: string,
    now: Date,
    metadata?: Metadata,
  ): Promise<PresenceOutcome> {
    const operator = await this.repo.operatorFor(accountId, authUserId);
    if (!operator) return { status: 'no_such_operator' };

    const current = await this.repo.read(accountId, authUserId);
    await this.repo.touch(accountId, authUserId, now);

    const cause = (current.last_cause ?? null) as PresenceCause | null;
    const alreadyOnline = current.state === 'online';

    // ⭐ FR-016. A heartbeat undoes the SWEEP and nothing else. It must not decide that somebody's
    // lunch is over, and it must not revert a supervisor's correction using the very stale session
    // that made the correction necessary.
    if (alreadyOnline || !mayHeartbeatRaise(cause)) {
      return { status: 'unchanged', presence: await this.repo.read(accountId, authUserId) };
    }

    await this.write(accountId, authUserId, current, 'online', 'manual', {
      actorKind: 'user',
      actorRef: authUserId,
      metadata,
    });
    return { status: 'ok', presence: await this.repo.read(accountId, authUserId) };
  }

  /**
   * Lower one person's availability from the sweep.
   *
   * Guarded by `isLowerAvailability` rather than trusting the caller: the sweep computing a target
   * is one thing, and the invariant *"the sweep never raises"* is another. Asserting it here means a
   * future caller cannot bypass it by passing a different target.
   */
  async lowerFromSweep(
    accountId: string,
    authUserId: string,
    to: PresenceState,
    jobName: string,
  ): Promise<PresenceOutcome> {
    const current = await this.repo.read(accountId, authUserId);
    if (!isLowerAvailability(current.state as PresenceState, to)) {
      return { status: 'unchanged', presence: current };
    }

    await this.write(accountId, authUserId, current, to, 'auto_inactivity', {
      actorKind: 'system',
      // A system actor names itself — `buildTransitionRow` refuses one that does not, and the sweep
      // is precisely the case that rule was written for.
      actorRef: jobName,
    });
    return { status: 'ok', presence: await this.repo.read(accountId, authUserId) };
  }

  /** Switch a channel off or back on. */
  async setChannelAvailability(
    accountId: string,
    authUserId: string,
    channel: string,
    available: boolean,
    metadata?: Metadata,
  ): Promise<PresenceOutcome> {
    const operator = await this.repo.operatorFor(accountId, authUserId);
    if (!operator) return { status: 'no_such_operator' };

    const blocked = (await this.repo.blockedChannels(accountId, [authUserId])).get(authUserId) ?? [];
    const isBlocked = blocked.includes(channel);

    // FR-015 again: switching on a channel that is already on changes nothing and records nothing.
    if (isBlocked === !available) {
      return { status: 'unchanged', presence: await this.repo.read(accountId, authUserId) };
    }

    const correlationId = randomUUID();
    await this.repo.setChannelBlock(accountId, authUserId, channel, !available, (tx) =>
      this.transitions.record(tx as never, {
        accountId,
        type: 'operator.channel_availability_changed',
        occurredAt: new Date(),
        actorKind: 'user',
        actorRef: authUserId,
        subjectKind: 'operator',
        subjectId: authUserId,
        payload: { channel, available: String(available), cause: 'manual' },
        dims: buildOperatorDims(metadata, { channel }),
        correlationId,
      }),
    );

    return { status: 'ok', presence: await this.repo.read(accountId, authUserId) };
  }

  /** The single write path, so the transition can never be forgotten on one branch. */
  private async write(
    accountId: string,
    authUserId: string,
    current: PresenceRow,
    to: PresenceState,
    cause: PresenceCause,
    opts: {
      labelId?: string | null;
      actorKind: 'user' | 'system';
      actorRef: string;
      metadata?: Metadata;
      audited?: boolean;
    },
  ): Promise<void> {
    // ONE correlation id per ACT, shared by the transition and the audit entry — that is what ties
    // the two stores together without either becoming the other's source of truth.
    const correlationId = randomUUID();
    await this.repo.applyState(
      accountId,
      authUserId,
      { state: to, cause, labelId: opts.labelId },
      (tx) =>
        this.transitions.record(tx as never, {
          accountId,
          type: 'operator.presence_changed',
          occurredAt: new Date(),
          actorKind: opts.actorKind,
          actorRef: opts.actorRef,
          subjectKind: 'operator',
          // The AUTH user id — the identifier this stream already uses for `actor_ref` everywhere
          // (research R3), never the operator profile id.
          subjectId: authUserId,
          // Ids and enums only. The displayed LABEL's text is deliberately absent: it is
          // operator-authored free text, and the payload allow-list would refuse it anyway.
          payload: { from: current.state, to, cause },
          dims: buildOperatorDims(opts.metadata),
          correlationId,
        }),
      opts.audited ? (tx) => this.writeAuditEntry(tx, accountId, authUserId, opts.actorRef) : undefined,
    );
  }

  /**
   * The audit entry for a supervisor's override — ⭐ the ONE presence act that is both durable
   * history and a sensitive action (FR-023).
   *
   * ── Why `buildEntry` and not `AuditRepository.statement` ────────────────────────────────────────
   * `statement()` returns an UNEXECUTED create bound to the outer client, for callers whose
   * transaction is a BATCH (`$transaction([...])`). This path uses an INTERACTIVE transaction,
   * because the presence upsert and the transition insert already do — so the create must run on
   * `tx`, not on the client `statement()` captured. Building the validated data and inserting it
   * here is the honest way to do that; reusing `statement()` would silently write outside the
   * transaction, which is the one thing this must not do.
   *
   * Validation still happens before the insert: `buildEntry` refuses an unknown action, a missing
   * actor, and any detail the allow-list cannot express. A refused entry therefore rolls back the
   * whole act — feature 015's rule that an unrecordable sensitive action is not performed.
   */
  private async writeAuditEntry(
    tx: unknown,
    accountId: string,
    subjectAuthUserId: string,
    actorUserId: string,
  ): Promise<void> {
    // ⚠️ NO `detail`, and the reason is worth recording rather than working around.
    //
    // The first draft passed `{ from, to }` and the audit allow-list REFUSED it: the `privilege`
    // class permits `scope | permissionKey | roleKey | grant | affectedCount`, because its details
    // are about PERMISSIONS. That refusal is the catalogue telling the truth about a reuse this
    // feature made knowingly (research R10): an override changes no permission, and the class fits
    // the accountability need rather than the vocabulary.
    //
    // Widening the allow-list to accommodate it would dilute a well-scoped list for one caller. The
    // better answer is that the two stores each answer their OWN question and neither duplicates the
    // other: the audit entry says *who did this to whom*, and the transition — written in the same
    // transaction, one line above — says *from what, to what, and why*. Reading them together is the
    // point of writing both.
    //
    // ⚠️ Known limit: `AuditEntryInput` has no correlation field, so the tie between the two rows is
    // (account, target, instant) rather than an explicit id — even though the transition's own
    // `correlation_id` comment claims otherwise. That gap predates this feature and belongs to
    // whoever builds the B2 reader; it is named here so it is not rediscovered as a surprise.
    const data = buildEntry({
      action: 'presence.override',
      actorUserId,
      // WHOSE presence was changed. The ACTOR is the supervisor; the TARGET is the person it happened
      // to. Collapsing the two would make "who put me offline?" unanswerable, which is the entire
      // reason this act is audited at all.
      targetRef: subjectAuthUserId,
    });
    await (
      tx as { auditEntry: { create(a: Record<string, unknown>): Promise<unknown> } }
    ).auditEntry.create({
      data: { account_id: accountId, ...data, detail_json: data.detail_json ?? undefined },
    });
  }
}
