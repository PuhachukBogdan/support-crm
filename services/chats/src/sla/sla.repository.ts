import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { SlaStateSnapshot, StartIntent, StopIntent } from './first-reply';
import type { SlaPolicy } from './policy-resolution';

export interface SlaPolicyRow extends SlaPolicy {
  id: string;
}

const STATE_SELECT = {
  id: true,
  conversation_id: true,
  outcome: true,
  started_at: true,
  deadline_at: true,
  target_minutes: true,
  first_reply_at: true,
  first_reply_seconds: true,
  breach_announced_at: true,
} as const;

const POLICY_SELECT = {
  id: true,
  target_minutes: true,
  scope_priority: true,
  scope_brand_id: true,
} as const;

export interface SlaStateRow extends SlaStateSnapshot {
  id: string;
  conversation_id: string;
  first_reply_seconds: number | null;
}

/**
 * First-reply SLA persistence (feature 014, US2 — roadmap 4.7). Account-scoped via `forAccount`
 * (Principle I).
 *
 * ⚠️ The ONE unscoped read in this service lives in `sla-sweep.repository.ts`, not here. Everything in
 * this file is scoped, including the writes the sweep performs after it has selected which accounts
 * have work.
 *
 * ⚠️ This file must not import the event dispatcher (see `events/no-publish-from-repositories.spec.ts`).
 */
@Injectable()
export class SlaRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ── Policy ─────────────────────────────────────────────────────────────────────────────────────

  async listPolicies(accountId: string): Promise<SlaPolicyRow[]> {
    return (await this.prisma.forAccount(accountId).firstReplySlaPolicy.findMany({
      orderBy: [{ scope_brand_id: 'asc' }, { scope_priority: 'asc' }],
      select: POLICY_SELECT,
    })) as SlaPolicyRow[];
  }

  /** Upsert one scope's target. The `'*'` sentinels make the composite unique key usable (R7). */
  async setPolicy(
    accountId: string,
    input: { targetMinutes: number; scopePriority: string; scopeBrandId: string },
  ): Promise<SlaPolicyRow> {
    const db = this.prisma.forAccount(accountId);
    const existing = (await db.firstReplySlaPolicy.findFirst({
      where: { scope_priority: input.scopePriority, scope_brand_id: input.scopeBrandId },
      select: { id: true },
    })) as { id: string } | null;

    if (existing) {
      await db.firstReplySlaPolicy.updateMany({
        where: { id: existing.id },
        data: { target_minutes: input.targetMinutes },
      });
      return {
        id: existing.id,
        target_minutes: input.targetMinutes,
        scope_priority: input.scopePriority,
        scope_brand_id: input.scopeBrandId,
      };
    }
    return (await db.firstReplySlaPolicy.create({
      data: {
        account_id: accountId,
        target_minutes: input.targetMinutes,
        scope_priority: input.scopePriority,
        scope_brand_id: input.scopeBrandId,
      },
      select: POLICY_SELECT,
    })) as SlaPolicyRow;
  }

  // ── Per-conversation state ─────────────────────────────────────────────────────────────────────

  async getState(accountId: string, conversationId: string): Promise<SlaStateRow | null> {
    return (await this.prisma.forAccount(accountId).conversationSlaState.findFirst({
      where: { conversation_id: conversationId },
      select: STATE_SELECT,
    })) as SlaStateRow | null;
  }

  /** Create the clock row. */
  async start(accountId: string, conversationId: string, intent: StartIntent): Promise<void> {
    await this.prisma.forAccount(accountId).conversationSlaState.create({
      data: {
        account_id: accountId,
        conversation_id: conversationId,
        started_at: intent.started_at,
        target_minutes: intent.target_minutes,
        deadline_at: intent.deadline_at,
        outcome: 'running',
      },
    });
  }

  /**
   * Stop the clock. Guarded by `outcome: 'running'` in the WHERE, so two concurrent replies cannot
   * both write an outcome — the first wins and the second is a no-op (the FIRST reply is the one
   * being measured).
   */
  async stop(accountId: string, conversationId: string, intent: StopIntent): Promise<void> {
    await this.prisma.forAccount(accountId).conversationSlaState.updateMany({
      where: { conversation_id: conversationId, outcome: 'running' },
      data: {
        outcome: intent.outcome,
        first_reply_at: intent.first_reply_at,
        first_reply_seconds: intent.first_reply_seconds,
      },
    });
  }

  /**
   * Mark a breach. The `outcome: 'running'` + `breach_announced_at: null` predicate IS the
   * announce-once guarantee: whichever sweep tick gets there first flips the row, and every later
   * tick matches nothing. Returns true when THIS call performed the transition — so only the caller
   * that actually marked it goes on to emit the event.
   */
  async markBreached(accountId: string, conversationId: string, now: Date): Promise<boolean> {
    const res = await this.prisma.forAccount(accountId).conversationSlaState.updateMany({
      where: { conversation_id: conversationId, outcome: 'running', breach_announced_at: null },
      data: { outcome: 'breached', breach_announced_at: now },
    });
    return res.count > 0;
  }

  /** Conversation ids in this account whose measurement has a given outcome (the inbox filter). */
  async conversationIdsByOutcome(accountId: string, outcome: string): Promise<string[]> {
    const rows = (await this.prisma.forAccount(accountId).conversationSlaState.findMany({
      where: { outcome },
      select: { conversation_id: true },
    })) as { conversation_id: string }[];
    return rows.map((r) => r.conversation_id);
  }
}
