import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { TransitionRecorder } from '../transition/transition.recorder';
import { subjectSet, type TransitionActor } from '../transition/conversation-transitions';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE THIRD UNSCOPED READ IN THIS SERVICE. Read this before changing it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Feature 023, roadmap 4.18 (FR-018 — the ten-minute arm of the window). Sibling of
 * `sla/sla-sweep.repository.ts`, which carries the full reasoning for why a tenant-agnostic read can
 * be judged compliant with Principle I rather than a violation. The same five fences apply, unchanged:
 *
 *   1. **Ids only.** The `select` is `{ account_id, id }` — no title, no body, no player, no status.
 *   2. **Nothing leaves the service** but counts; the rpc answers with numbers and no rows.
 *   3. **No caller can reach it** — invoked only from `ChatsMaintenanceService`, which requires
 *      `x-actor-kind: system` and has no gateway route.
 *   4. **Every write stays scoped.** This step chooses *which* conversations have an expired window;
 *      the close itself runs through `forAccount(accountId)` like every other write.
 *   5. **Bounded** — the limit is server-capped, so one tick cannot scan the world.
 *
 * ── Why a sweep and not a delayed job per conversation (research R5) ─────────────────────────────
 * At ~3 000 conversations a day, a per-conversation timer is 3 000 scheduled jobs a day to close a
 * window that one indexed query answers. Feature 014 already recorded the failure mode: a lost delayed
 * job is a breach that is never detected, silently. A sweep that misses a tick simply closes the
 * window on the next one.
 *
 * ── Why the close is a second query per row rather than one bulk update ─────────────────────────
 * Closing means `subject_source = 'auto'` **and** `subject = subject ?? category` — a per-row COALESCE
 * that `updateMany` cannot express. It could be split into two bulk updates plus a remainder, but the
 * remainder (no candidate *and* a known topic) is the only interesting case and today it is empty,
 * because automatic classification is not built. Two bulk updates to avoid a loop over a capped batch
 * of minutes-old conversations is complexity bought with nothing.
 *
 * **Do not add anything else to this file.** Its value is that it is one selection query and one close.
 */

/** A conversation whose derivation window has expired, identified only enough to act on it. */
export interface ExpiredSubjectWindow {
  account_id: string;
  id: string;
}

/**
 * The window's third arm (FR-018), in minutes — read from `SUBJECT_WINDOW_TIMEOUT_MINUTES`.
 *
 * ⚠️ Read at call time, not captured at construction: the config guard runs at boot, so the value is
 * always present, and reading it here keeps the sweep a plain injectable with no config dependency to
 * thread through its two callers' tests.
 *
 * It IS configuration (unlike the title cap — see `config.ts`), because exactly one thing reads it and
 * a test environment legitimately wants a shorter window. The fallback exists only so a unit test does
 * not need an environment; the container cannot reach it, because the service refuses to start without
 * the key.
 */
export const DEFAULT_SUBJECT_WINDOW_MINUTES = 10;

export function subjectWindowMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SUBJECT_WINDOW_TIMEOUT_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SUBJECT_WINDOW_MINUTES;
}

/** Server cap, mirroring the SLA sweep's. One tick cannot scan the world. */
const MAX_SWEEP_LIMIT = 5_000;

@Injectable()
export class SubjectSweepRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Conversations across ALL accounts whose window is still open and older than the timeout.
   *
   * The predicate matches `(subject_source, created_at)`, an index that exists for exactly this query.
   * Ordered oldest-first so a capped batch closes the longest-overdue windows.
   */
  async findExpiredWindows(limit: number, now: Date): Promise<ExpiredSubjectWindow[]> {
    const cutoff = new Date(now.getTime() - subjectWindowMinutes() * 60 * 1000);
    return (await this.prisma.conversation.findMany({
      where: { subject_source: null, created_at: { lte: cutoff } },
      orderBy: [{ created_at: 'asc' }],
      take: Math.max(1, Math.min(MAX_SWEEP_LIMIT, Math.trunc(limit) || 1)),
      // IDS ONLY. Adding a field here is a Principle-I change, not a convenience.
      select: { account_id: true, id: true },
    })) as ExpiredSubjectWindow[];
  }

  /**
   * Close one window, under its own account scope, recording the transition in the SAME transaction.
   *
   * Returns `true` when this call closed it, `false` when it was already closed — the
   * `subject_source: null` predicate is repeated in BOTH the read and the write, so a customer's third
   * message that closed it a millisecond earlier wins and this tick does nothing. Without that, a
   * sweep could overwrite a title the write path had just set.
   *
   * ⚠️ **One transaction, not two writes.** ADR 0046 §4a: *recording* is atomic even though *delivery*
   * is best-effort. A closed window with no record of who closed it and when is exactly the hole this
   * feature exists to prevent, and it is invisible — the title looks fine.
   */
  async closeWindow(
    accountId: string,
    conversationId: string,
    recorder: TransitionRecorder,
    actor: TransitionActor,
    now: Date,
  ): Promise<boolean> {
    const db = this.prisma.forAccount(accountId) as unknown as SweepTxCapableClient;

    // Called ON the client, never destructured: pulling `$transaction` into a variable loses its
    // `this` and Prisma dies on `this._engineConfig` — feature 013's live-only defect.
    return db.$transaction(async (tx) => {
      const before = await tx.conversation.findFirst({
        where: { id: conversationId, subject_source: null },
        select: CLOSE_SELECT,
      });
      if (!before) return false;

      // FR-019: the candidate if one was chosen, else the topic, else nothing. Never a fragment, and
      // never the canonical dash — that is a rendering rule (ADR 0044), not a stored value.
      const subject = before.subject ?? before.category ?? null;

      const { count } = await tx.conversation.updateMany({
        where: { id: conversationId, subject_source: null },
        data: { subject, subject_source: 'auto' },
      });
      if (count === 0) return false;

      await recorder.record(tx, subjectSet(accountId, before, 'auto', actor, now));
      return true;
    });
  }
}

/** The transaction slice this sweep touches. Same narrow-cast approach as the message write path. */
interface SweepTx {
  conversation: {
    findFirst(args: unknown): Promise<ClosedWindowRow | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  conversationTransition: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

interface SweepTxCapableClient {
  $transaction<T>(fn: (tx: SweepTx) => Promise<T>): Promise<T>;
}

/** The columns closing a window needs — the title candidate, the topic, and the snapshot dimensions. */
const CLOSE_SELECT = {
  id: true,
  status: true,
  brand_id: true,
  channel: true,
  assignee_operator_id: true,
  subject: true,
  category: true,
} as const;

export interface ClosedWindowRow {
  id: string;
  status: string | null;
  brand_id: string;
  channel: string | null;
  assignee_operator_id: string | null;
  subject: string | null;
  category: string | null;
}
