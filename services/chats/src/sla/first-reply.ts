/**
 * First-reply clock decisions (feature 014, US2 — roadmap 4.7). Pure: every function takes `now`
 * explicitly, so the whole state machine is testable without waiting for time to pass.
 *
 *   (no row) ──inbound player message (a target resolves)──► running
 *   running  ──first PUBLIC staff reply──► met | breached (late reply still records the duration)
 *   running  ──deadline passed, swept──► breached
 *   met / breached: TERMINAL — later messages never change the first-reply outcome.
 *
 * Two rules that are easy to get wrong and are asserted directly:
 *  • A **private note** is inert. It is not a reply to the player, so it neither stops the clock nor
 *    sets `first_reply_at` (FR-012 — the SEC-13 distinction, re-applied on a new surface).
 *  • A status change, **including `resolved`**, neither stops nor pauses the clock. Resolving a
 *    conversation without answering the player is precisely the case worth catching.
 */

export type SlaOutcome = 'running' | 'met' | 'breached';

export interface SlaStateSnapshot {
  outcome: SlaOutcome;
  started_at: Date;
  deadline_at: Date;
  target_minutes: number;
  first_reply_at: Date | null;
  breach_announced_at: Date | null;
}

/** What to write when a clock starts. */
export interface StartIntent {
  started_at: Date;
  target_minutes: number;
  deadline_at: Date;
}

/** What to write when the first public reply lands. */
export interface StopIntent {
  outcome: 'met' | 'breached';
  first_reply_at: Date;
  first_reply_seconds: number;
}

export const MINUTE_MS = 60_000;

/**
 * Decide whether an inbound player message starts a clock.
 * @param existing the conversation's current SLA row, if any
 * @param targetMinutes the resolved target, or null when no policy applies
 * @returns the row to create, or null to do nothing
 */
export function decideStart(
  existing: SlaStateSnapshot | null,
  targetMinutes: number | null,
  now: Date,
): StartIntent | null {
  // Only the FIRST inbound message starts the measurement; later ones never restart it, or a chatty
  // player could keep resetting the clock and no conversation would ever breach.
  if (existing) return null;
  if (!targetMinutes || targetMinutes <= 0) return null;
  return {
    started_at: now,
    target_minutes: targetMinutes,
    // Frozen at start: a later policy edit cannot retro-breach or un-breach this conversation
    // (FR-016), and the sweep predicate stays a plain indexed comparison (research R8).
    deadline_at: new Date(now.getTime() + targetMinutes * MINUTE_MS),
  };
}

/**
 * Decide whether a staff message stops the clock.
 * @param isPublicReply false for a private note — which must change nothing at all
 */
export function decideStop(
  existing: SlaStateSnapshot | null,
  isPublicReply: boolean,
  now: Date,
): StopIntent | null {
  if (!existing) return null;
  if (!isPublicReply) return null; // a private note is not a reply to the player (FR-012)
  if (existing.outcome !== 'running') return null; // terminal — the FIRST reply is already decided
  const seconds = Math.max(0, Math.round((now.getTime() - existing.started_at.getTime()) / 1000));
  return {
    // A reply that arrives after the deadline does NOT rescue the outcome. "We answered, 40 minutes
    // late" is the operationally useful fact, so the duration is still recorded.
    outcome: now.getTime() > existing.deadline_at.getTime() ? 'breached' : 'met',
    first_reply_at: now,
    first_reply_seconds: seconds,
  };
}

/**
 * Is this row due to be marked breached? Used by the sweep after the same predicate has already
 * narrowed the rows in SQL — this is the in-process double-check, not the primary filter.
 */
export function isDueForBreach(state: SlaStateSnapshot, now: Date): boolean {
  return (
    state.outcome === 'running' &&
    state.breach_announced_at === null &&
    now.getTime() >= state.deadline_at.getTime()
  );
}
