import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type { AutomationTrigger } from '../events/events.types';
import type { MacroAction } from '../macros/macro-definition';
import { triggerOfStored, toStoredDefinition, type RuleDefinition } from './rule-definition';
import { TransitionRecorder } from '../transition/transition.recorder';
import { priorityWrite } from '../conversation/urgency';
import {
  assigned,
  statusChanged,
  systemActor,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
} from '../transition/conversation-transitions';

export interface AutomationRow {
  id: string;
  name: string;
  active: boolean;
  position: number;
  revision: number;
  author_user_id: string;
  /**
   * Feature 024 (roadmap 5.3): the rule applies only to work routed to this group. `null` = unscoped,
   * which is every rule that existed before this feature. A soft ref to `auth.Group.id`, never joined.
   */
  scope_group_id: string | null;
  definition: unknown;
  created_at: Date;
  updated_at: Date;
}

export type RunOutcome = 'applied' | 'not_matched' | 'refused';

export interface RunRecord {
  automationId: string;
  automationRevision: number;
  conversationId: string;
  trigger: AutomationTrigger;
  eventKey: string;
  outcome: RunOutcome;
  reason?: string;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  automation_revision: number;
  conversation_id: string;
  trigger: string;
  outcome: string;
  reason: string | null;
  created_at: Date;
}

const ROW_SELECT = {
  id: true,
  name: true,
  active: true,
  position: true,
  revision: true,
  author_user_id: true,
  // Feature 024 (roadmap 5.3): the rule's group scope. Selected on the engine's hot read so the
  // filter costs nothing extra.
  scope_group_id: true,
  definition: true,
  created_at: true,
  updated_at: true,
} as const;

const RUN_SELECT = {
  id: true,
  automation_id: true,
  automation_revision: true,
  conversation_id: true,
  trigger: true,
  outcome: true,
  reason: true,
  created_at: true,
} as const;

/** Prisma's unique-constraint violation. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/**
 * Automation rule + run-record persistence (feature 014, US1 — roadmap 4.6). Account-scoped via
 * `forAccount` (Principle I) — including the engine's writes, which have **no human caller** and are
 * the first such writes in the product. `updateMany`/`deleteMany`/`findFirst` (never `findUnique`) so
 * the injected `account_id` predicate composes.
 *
 * ⚠️ This file deliberately does NOT import the event dispatcher. Only controllers publish events, so
 * an automation's writes cannot emit one and no reaction can cascade (FR-006 / research R4). That
 * absence is enforced by `events/no-publish-from-repositories.spec.ts` — if you are here to add a
 * publish call, read the reasoning there first.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class AutomationsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
  ) {}

  // ── Authoring ──────────────────────────────────────────────────────────────────────────────────

  async list(
    accountId: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: AutomationRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = {};
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.OR = [{ created_at: { lt: at } }, { AND: [{ created_at: at }, { id: { lt: cursor.id } }] }];
    }
    const rows = (await this.prisma.forAccount(accountId).automation.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: ROW_SELECT,
    })) as AutomationRow[];
    return page(rows, limit);
  }

  async getById(accountId: string, id: string): Promise<AutomationRow | null> {
    return (await this.prisma.forAccount(accountId).automation.findFirst({
      where: { id },
      select: ROW_SELECT,
    })) as AutomationRow | null;
  }

  async create(
    accountId: string,
    input: {
      name: string;
      definition: RuleDefinition;
      authorUserId: string;
      position: number;
      active: boolean;
      /** Feature 024: bind the rule to a desk. Absent/empty = unscoped, which is the default. */
      scopeGroupId?: string | null;
    },
  ): Promise<AutomationRow> {
    return (await this.prisma.forAccount(accountId).automation.create({
      data: {
        account_id: accountId,
        name: input.name,
        active: input.active,
        definition: toStoredDefinition(input.definition) as never,
        author_user_id: input.authorUserId,
        position: input.position,
        revision: 1,
        scope_group_id: input.scopeGroupId || null,
      },
      select: ROW_SELECT,
    })) as AutomationRow;
  }

  /**
   * Partial update. A definition change bumps `revision` so every run record can name exactly which
   * definition executed (FR-007) — otherwise "why did this rule do that?" is unanswerable after an
   * edit. Returns null when the id is not in this account.
   */
  async update(
    accountId: string,
    id: string,
    patch: {
      name?: string;
      definition?: RuleDefinition;
      position?: number;
      active?: boolean;
      /**
       * Feature 024. `null` or `''` UNSCOPES the rule — an explicit act, distinct from `undefined`,
       * which leaves the binding alone. A patch that could not express "remove the scope" would make
       * a desk binding permanent, and a rule nobody can widen again is a rule someone deletes.
       */
      scopeGroupId?: string | null;
    },
  ): Promise<AutomationRow | null> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.position !== undefined) data.position = patch.position;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.scopeGroupId !== undefined) data.scope_group_id = patch.scopeGroupId || null;
    if (patch.definition !== undefined) {
      data.definition = toStoredDefinition(patch.definition);
      data.revision = { increment: 1 };
    }
    if (Object.keys(data).length === 0) return this.getById(accountId, id);

    const res = await this.prisma.forAccount(accountId).automation.updateMany({ where: { id }, data });
    if (res.count === 0) return null;
    return this.getById(accountId, id);
  }

  /** True when a row was removed; false when the id is not in this account. */
  async remove(accountId: string, id: string): Promise<boolean> {
    const res = await this.prisma.forAccount(accountId).automation.deleteMany({ where: { id } });
    return res.count > 0;
  }

  /**
   * Delete a rule AND its audit entry in one transaction (feature 015 / spec Q3): removing a rule that acts
   * by itself is a sensitive act, so the deletion and its record commit together or neither happens. The
   * caller supplies the already-built audit statement so this repository stays free of audit knowledge.
   *
   * ⚠️ The caller MUST have established that the rule exists in this account first. `deleteMany` reports a
   * count of 0 for an id that is not there, but the transaction still commits — so calling this blind would
   * file an audit entry for a deletion that never happened. A trail that records non-events is worse than
   * one with a gap: a reader cannot tell the difference. Hence: read, then delete+record.
   *
   * Returns the number of rows removed (1 when the pre-checked rule was deleted).
   */
  async removeAudited(accountId: string, id: string, auditStatement: unknown): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [res] = (await db.$transaction([
      db.automation.deleteMany({ where: { id } }),
      auditStatement,
    ] as never)) as unknown as [{ count: number }];
    return res.count;
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Active rules for one trigger, in evaluation order: `position` then `created_at` (spec
   * Assumptions). The order must not depend on wall-clock timing or on which process handled the
   * event, so it is an explicit ORDER BY rather than whatever the planner returns.
   */
  async listActiveByTrigger(accountId: string, trigger: AutomationTrigger): Promise<AutomationRow[]> {
    const rows = (await this.prisma.forAccount(accountId).automation.findMany({
      where: { active: true },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      select: ROW_SELECT,
    })) as AutomationRow[];
    // The trigger lives inside the JSON definition, so it is filtered here rather than in SQL. The
    // set is small and already narrowed by (account_id, active) — the indexed part of the query.
    return rows.filter((r) => safeTrigger(r.definition) === trigger);
  }

  /** Labels attached to a conversation — a condition input (`labelIds`). */
  async labelIdsFor(accountId: string, conversationId: string): Promise<string[]> {
    const links = (await this.prisma.forAccount(accountId).conversationLabel.findMany({
      where: { conversation_id: conversationId },
      select: { label_id: true },
    })) as { label_id: string }[];
    return links.map((l) => l.label_id);
  }

  /**
   * Record an evaluation that changed nothing (`not_matched` / `refused`).
   *
   * A unique-constraint violation means this rule already handled this event, so it is a **successful
   * no-op** — the at-most-once guarantee is the index, not a check-then-write (research R6).
   * Returns false when the record already existed.
   */
  async recordRun(accountId: string, run: RunRecord): Promise<boolean> {
    try {
      await this.prisma.forAccount(accountId).automationRun.create({ data: runData(accountId, run) });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /**
   * Apply a rule's actions AND write its run record in **one** transaction (FR-005/FR-008).
   *
   * Two properties come from one batch:
   *  • all-or-nothing — either every action lands or none does;
   *  • at-most-once — the run record shares the transaction, so a duplicate `event_key` aborts the
   *    whole batch and nothing is applied twice.
   *
   * The BATCH form of `$transaction` is used on purpose (as 013's macro apply does). The interactive
   * callback form is what produced 013's live-only defect — pulling `$transaction` into a variable
   * loses its `this` and Prisma dies on `_engineConfig`. No read-modify-write is needed here, so the
   * form that cannot have that bug is the right one.
   *
   * Returns false when the run was already recorded (nothing applied).
   */
  async applyWithRun(
    accountId: string,
    conversationId: string,
    actions: MacroAction[],
    run: RunRecord,
  ): Promise<boolean> {
    const db = this.prisma.forAccount(accountId);

    // Feature 023 — the before-row, read before the batch is assembled. Same reasoning as the macro
    // applier: this batch is all-or-nothing BY ORDERING, so reading `from` one step earlier accepts
    // exactly the staleness the surrounding design already accepts.
    const before = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: TRANSITION_BEFORE_SELECT,
    })) as ConversationBefore | null;

    // The rule names itself. A status change caused by automation attributed to "the system" is the
    // entry that makes the trail useless — "which rule did this?" is the whole question.
    const actor = systemActor(run.automationId);
    const now = new Date();
    const transitionStatements: unknown[] = [];

    const statements: unknown[] = actions.map((a) => {
      switch (a.type) {
        case 'MACRO_ACTION_TYPE_SET_STATUS':
          if (before) {
            transitionStatements.push(
              this.transitions.buildStatement(
                db as never,
                statusChanged(accountId, before, a.value, actor, now),
              ),
            );
          }
          return db.conversation.updateMany({
            where: { id: conversationId },
            // Feature 032: the stored value IS the key (see `macros.repository.ts`).
            data: { status: a.value },
          });
        case 'MACRO_ACTION_TYPE_SET_PRIORITY':
          return db.conversation.updateMany({
            where: { id: conversationId },
            // Feature 031: the word and its urgency rank land together. A rule that set the word alone
            // would leave the queue ordered by the PREVIOUS priority, and the list would look right.
            data: { ...priorityWrite(a.value) },
          });
        case 'MACRO_ACTION_TYPE_ASSIGN':
          if (before) {
            transitionStatements.push(
              this.transitions.buildStatement(
                db as never,
                assigned(accountId, before, a.value, actor, now),
              ),
            );
          }
          return db.conversation.updateMany({
            where: { id: conversationId },
            data: { assignee_operator_id: a.value },
          });
        case 'MACRO_ACTION_TYPE_ADD_LABEL':
          return db.conversationLabel.upsert({
            where: {
              conversation_id_label_id: { conversation_id: conversationId, label_id: a.value },
            },
            create: { conversation_id: conversationId, label_id: a.value },
            update: {},
          });
      }
    });
    statements.push(db.automationRun.create({ data: runData(accountId, run) }));
    // Transitions ride the SAME batch. Note the ordering: they go in AFTER the run record, so the
    // at-most-once unique index still decides whether anything lands at all — a duplicate delivery
    // rolls back the transitions along with the actions, which is the correct outcome.
    statements.push(...transitionStatements);

    try {
      await db.$transaction(statements as never);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false; // already handled — nothing applied.
      throw err;
    }
  }

  async listRuns(
    accountId: string,
    filter: { automationId?: string; conversationId?: string },
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: AutomationRunRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = {};
    if (filter.automationId) where.automation_id = filter.automationId;
    if (filter.conversationId) where.conversation_id = filter.conversationId;
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.OR = [{ created_at: { lt: at } }, { AND: [{ created_at: at }, { id: { lt: cursor.id } }] }];
    }
    const rows = (await this.prisma.forAccount(accountId).automationRun.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: RUN_SELECT,
    })) as AutomationRunRow[];
    return page(rows, limit);
  }
}

/** The run-record row. `reason` is short and PII-free by contract (FR-020). */
function runData(accountId: string, run: RunRecord) {
  return {
    account_id: accountId,
    automation_id: run.automationId,
    automation_revision: run.automationRevision,
    conversation_id: run.conversationId,
    trigger: run.trigger,
    event_key: run.eventKey,
    outcome: run.outcome,
    reason: run.reason ?? null,
  };
}

/**
 * The trigger of a stored definition; null when the blob is unreadable (such a rule never runs).
 *
 * Feature 032: reads the trigger ALONE (`triggerOfStored`), so the trigger index does not depend on the
 * account's status catalogue — see that function for why a retired status must not silently un-index a
 * rule.
 */
function safeTrigger(definition: unknown): string | null {
  try {
    return triggerOfStored(definition);
  } catch {
    return null;
  }
}

function page<T extends { id: string; created_at: Date }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor: Cursor | null } {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    rows: kept,
    nextCursor: hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
  };
}
