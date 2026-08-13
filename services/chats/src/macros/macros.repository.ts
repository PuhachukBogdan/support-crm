import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { MacroAction, MacroExtras } from './macro-definition';
import { extrasOfDefinition, parseDefinition, toDefinition } from './macro-definition';
import { priorityWrite } from '../conversation/urgency';
import { TransitionRecorder } from '../transition/transition.recorder';
import { StatusRepository } from '../status/status.repository';
import {
  assigned,
  statusChanged,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
  type TransitionActor,
} from '../transition/conversation-transitions';
// ⭐ W30 (US4): the U9 lock as a predicate, shared with the automations applier and the fields writes.
import { classificationLock, classifiedByOf } from '../fields/classification-write';

export interface MacroRow {
  id: string;
  name: string;
  actions: MacroAction[];
  /** ⭐ W29: the reply TEXT (inserted into the composer, never sent) and «кому доступен». */
  text: string;
  groupIds: string[];
  /** ⭐ W29: applications in the last 7 days — the operator's counter. */
  appliedLast7: number;
}

/**
 * Macro read/write path (feature 013, US2 — roadmap 4.5). Account-scoped via `forAccount`
 * (Principle I).
 *
 * `applyActions` executes the whole bundle inside **one** `$transaction` on the scoped client, so a
 * macro is all-or-nothing (FR-008 / SC-004): if any statement fails, none of them lands. Permission
 * and resource checks happen in the controller **before** this is called — a refusal must write
 * nothing at all, rather than rely on a rollback.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class MacrosRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
    // Feature 032: re-validating a stored definition means asking the ACCOUNT which statuses exist.
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  async list(accountId: string): Promise<MacroRow[]> {
    const rows = (await this.prisma.forAccount(accountId).macro.findMany({
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true, definition: true },
    })) as { id: string; name: string; definition: unknown }[];
    // A stored definition is re-validated on read: a blob written by an older, looser version must
    // not be presented as if this version understood it. Feature 032 adds the account's statuses to
    // "understood" — a macro naming a retired status lists with NO actions rather than with a step the
    // apply path would refuse, so the screen and the button agree.
    const keys = await this.statuses.activeKeys(accountId);
    // ⭐ W29: the weekly counter — ONE grouped count for the whole page, never one query per macro.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const counts = (await this.prisma.forAccount(accountId).macroApplication.groupBy({
      by: ['macro_id'],
      where: { applied_at: { gte: since } },
      _count: { macro_id: true },
    } as never)) as unknown as { macro_id: string; _count: { macro_id: number } }[];
    const applied = new Map(counts.map((c) => [c.macro_id, c._count.macro_id]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      actions: safeActions(r.definition, keys),
      ...extrasOfDefinition(r.definition),
      appliedLast7: applied.get(r.id) ?? 0,
    }));
  }

  async create(
    accountId: string,
    name: string,
    actions: MacroAction[],
    extras?: MacroExtras,
  ): Promise<MacroRow> {
    const row = (await this.prisma.forAccount(accountId).macro.create({
      data: { account_id: accountId, name, definition: toDefinition(actions, extras) as never },
      select: { id: true, name: true },
    })) as { id: string; name: string };
    return {
      id: row.id,
      name: row.name,
      actions,
      text: extras?.text ?? '',
      groupIds: extras?.groupIds ?? [],
      appliedLast7: 0,
    };
  }

  /** ⭐ W29: deletion — the audit statement rides the same transaction (act + entry, together). */
  async delete(accountId: string, id: string, auditStatement: unknown): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [res] = (await db.$transaction([
      db.macro.deleteMany({ where: { id } }),
      auditStatement,
    ] as never)) as unknown as [{ count: number }];
    return res.count;
  }

  /** The stored macro, or null when it is not in this account. */
  async getById(
    accountId: string,
    id: string,
  ): Promise<{ id: string; name: string; definition: unknown } | null> {
    return (await this.prisma.forAccount(accountId).macro.findFirst({
      where: { id },
      select: { id: true, name: true, definition: true },
    })) as { id: string; name: string; definition: unknown } | null;
  }

  /**
   * Apply every action to one conversation **atomically**. Statements are prepared first and handed
   * to `$transaction` as a batch — all or nothing (FR-008).
   */
  async applyActions(
    accountId: string,
    conversationId: string,
    macroId: string,
    actions: MacroAction[],
    actor: TransitionActor,
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);

    // Feature 023 — the before-row, read BEFORE the batch is assembled.
    //
    // ⚠️ Why reading it here rather than inside the transaction is correct HERE and not elsewhere:
    // this batch's guarantee is *all-or-nothing by ORDERING* (feature 013, FR-008) — every check
    // already happens before the batch opens, so a refused macro writes zero rows. Reading `from`
    // one step earlier accepts exactly the same staleness the surrounding design already accepts,
    // and it avoids converting a proven batch into an interactive transaction to gain nothing.
    const before = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: TRANSITION_BEFORE_SELECT,
    })) as ConversationBefore | null;

    const now = new Date();
    const transitionStatements: unknown[] = [];

    const statements = actions.map((a) => {
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
            // Feature 032: the stored value IS the key. The `CONVERSATION_STATUS_` → scalar decoder that
            // used to sit here is gone, and the account's FK is the last line: a key nobody configured
            // cannot be written even if a definition somehow named one.
            data: { status: a.value },
          });
        case 'MACRO_ACTION_TYPE_ADD_LABEL':
          return db.conversationLabel.upsert({
            where: {
              conversation_id_label_id: { conversation_id: conversationId, label_id: a.value },
            },
            create: { conversation_id: conversationId, label_id: a.value },
            update: {},
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
        /**
         * ⚠️ W29 fixed a LATENT defect here: `SET_PRIORITY` had been in the shared vocabulary since
         * feature 014 — validated at define, permission-checked at apply — and this switch had no
         * case for it. The AUTOMATION applier had one; the macro applier mapped it to `undefined`
         * and the whole batch died. Found by reading, pinned by a test that fails on the old code.
         * `priorityWrite`: the word and its urgency rank land together, the setPriority rule.
         */
        case 'MACRO_ACTION_TYPE_SET_PRIORITY':
          return db.conversation.updateMany({
            where: { id: conversationId },
            data: { ...priorityWrite(a.value) },
          });
        /**
         * ⭐ W29 (R46/U9): the classification pair. `classified_by` lands WITH the value and names
         * the OPERATOR, not the macro — an explicit human act (invoking a macro is one, feature
         * 023's own rule) wins over the autoclassifier and LOCKS the field: the classifier's
         * contract is that it never overwrites a human's word (`classified_by !== 'ai'`).
         */
        case 'MACRO_ACTION_TYPE_SET_CATEGORY':
          // ⭐ W30 (US4): through the ONE classification-write helper. For a macro the actor is a
          // person (deliberate invocation — U9 counts it as human), so the lock extension is empty
          // and the write stamps the operator id; the predicate exists so an AUTOMATED caller of
          // the same helper cannot overwrite a human's word — structural, not a comment any more.
          return db.conversation.updateMany({
            where: { id: conversationId, ...classificationLock(actor) },
            data: { category: a.value, classified_by: classifiedByOf(actor) },
          });
        case 'MACRO_ACTION_TYPE_SET_SUB_CATEGORY':
          return db.conversation.updateMany({
            where: { id: conversationId, ...classificationLock(actor) },
            data: { sub_category: a.value, classified_by: classifiedByOf(actor) },
          });
      }
    });
    /**
     * ⭐ W29 — the usage fact rides the SAME batch: the operator's weekly counter counts real
     * applications, and an application that failed writes no row (all-or-nothing, FR-008).
     */
    const usage = db.macroApplication.create({
      data: { account_id: accountId, macro_id: macroId, applied_at: now },
    });
    // The transitions ride the SAME batch: either the macro and its record both land, or neither does.
    await db.$transaction([...statements, ...transitionStatements, usage] as never);
  }
}

/** Re-validate a stored definition; an unreadable blob yields no actions rather than a crash. */
function safeActions(definition: unknown, statusKeys: readonly string[]): MacroAction[] {
  try {
    // W30: category vocabulary explicitly unchecked on the APPLY path — see the validator's header.
    return parseDefinition(definition, statusKeys, 'unchecked');
  } catch {
    return [];
  }
}
