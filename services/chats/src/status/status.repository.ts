import { Inject, Injectable } from '@nestjs/common';
import { categoryToWire, NON_TERMINAL_CATEGORIES, type StatusCategory } from '@crm/common';
import { PrismaService } from '../prisma.service';

export interface StatusDefRow {
  key: string;
  category: string;
  agent_name: string;
  end_user_name: string;
  active: boolean;
  order: number;
}

const DEF_SELECT = {
  key: true,
  category: true,
  agent_name: true,
  end_user_name: true,
  active: true,
  order: true,
} as const;

/**
 * The account's status catalogue (feature 032, roadmap 4.16 — ADR 0040).
 *
 * ── Why this is a repository and not a constant ───────────────────────────────────────────────────
 * Statuses are per-account CONFIGURATION. A module-level list would make the authoring screen
 * (roadmap 3.14 / block W15a) a deployment instead of an INSERT, which is the whole reason the model
 * has two levels. The closed part — the six categories — lives in code, in
 * `libs/common/src/statuses/categories.ts`, and is the only part anything branches on.
 *
 * ── Every read is account-scoped, with no method-level exception ──────────────────────────────────
 * Unlike the SLA/export/transition sweeps, nothing here ever reads across accounts: a status only
 * means anything to the account that configured it. `forAccount` therefore fails closed everywhere in
 * this file, and `resolveActive` returning null for another account's key is tenant isolation working
 * rather than a missing row.
 *
 * ── No cache, deliberately ───────────────────────────────────────────────────────────────────────
 * Nine rows on an indexed unique key, and the alternative is a cache that must be invalidated by the
 * authoring screen that does not exist yet. A stale status vocabulary is a supervisor's edit that
 * silently did not happen; correctness first, and the query budget (Principle VII) is not troubled by
 * this table.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class StatusRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The whole catalogue in display order, INCLUDING retired statuses.
   *
   * A retired status is not settable but is still worn by existing tickets, so a screen that received
   * only the active ones would render those rows with no label at all — an empty badge reads as a bug
   * in the ticket rather than as a decision about the vocabulary.
   */
  async list(accountId: string): Promise<StatusDefRow[]> {
    return (await this.prisma.forAccount(accountId).conversationStatus.findMany({
      orderBy: [{ order: 'asc' }, { key: 'asc' }],
      select: DEF_SELECT,
    })) as StatusDefRow[];
  }

  /**
   * One SETTABLE status, or null.
   *
   * ⚠️ `active: true` is part of the predicate rather than a check afterwards: a retired status must be
   * indistinguishable from an unknown one at every write, or "may I still set Follow-up?" would have two
   * different answers depending on which caller asked.
   */
  async resolveActive(accountId: string, key: string): Promise<StatusDefRow | null> {
    if (!key) return null;
    return (await this.prisma.forAccount(accountId).conversationStatus.findFirst({
      where: { key, active: true },
      select: DEF_SELECT,
    })) as StatusDefRow | null;
  }

  /**
   * The keys a definition or a write may name: configured here, and not retired.
   *
   * Used by the macro/automation validators, which are pure and therefore cannot fetch it themselves —
   * they take it as a required parameter so a call site that forgets it fails to compile.
   */
  async activeKeys(accountId: string): Promise<string[]> {
    const rows = await this.prisma.forAccount(accountId).conversationStatus.findMany({
      where: { active: true },
      select: { key: true },
    });
    return (rows as Array<{ key: string }>).map((r) => r.key);
  }

  /**
   * Does this account have this key at all — ACTIVE OR RETIRED?
   *
   * ⚠️ The distinction from `resolveActive` is not pedantry: a retired status may not be SET, and must
   * still be FILTERABLE. Tickets that were parked in `Auto-Ended Chat` before it was retired still exist,
   * and a supervisor looking for them would otherwise be told their query is invalid.
   */
  async existsKey(accountId: string, key: string): Promise<boolean> {
    if (!key) return false;
    const row = await this.prisma.forAccount(accountId).conversationStatus.findFirst({
      where: { key },
      select: { key: true },
    });
    return !!row;
  }

  /**
   * The account's keys in one category — how a category FILTER becomes a query (the Archive screen).
   *
   * An empty result is a real answer ("this account has configured nothing in that category", which is
   * true of `closed` today) and the caller must turn it into an EMPTY page, never an unfiltered one.
   */
  async keysOfCategory(accountId: string, category: StatusCategory): Promise<string[]> {
    const rows = await this.prisma.forAccount(accountId).conversationStatus.findMany({
      where: { category },
      select: { key: true },
    });
    return (rows as Array<{ key: string }>).map((r) => r.key);
  }

  /**
   * Every key whose category is NOT terminal — i.e. work that still occupies somebody.
   *
   * ⚠️ This replaces a hard-coded `['open','pending']` in two load counters, and that was not a tidy-up:
   * the moment the nine statuses exist, a conversation in `in_progress` or `vip_pending` is real work
   * that the old list counted as nothing. An agent would have been handed more than their capacity by
   * exactly the number of escalated tickets they were holding.
   */
  async nonTerminalKeys(accountId: string): Promise<string[]> {
    const rows = await this.prisma.forAccount(accountId).conversationStatus.findMany({
      where: { category: { in: [...NON_TERMINAL_CATEGORIES] } },
      select: { key: true },
    });
    return (rows as Array<{ key: string }>).map((r) => r.key);
  }
}

/** A stored row → the wire shape. An unrecognised stored category yields UNSPECIFIED, never a guess. */
export function toStatusDefWire(r: StatusDefRow) {
  return {
    key: r.key,
    category: categoryToWire(r.category),
    agentName: r.agent_name,
    endUserName: r.end_user_name,
    active: r.active,
    order: r.order,
  };
}
