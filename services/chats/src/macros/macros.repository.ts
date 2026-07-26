import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { MacroAction } from './macro-definition';
import { parseDefinition, toDefinition } from './macro-definition';

export interface MacroRow {
  id: string;
  name: string;
  actions: MacroAction[];
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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<MacroRow[]> {
    const rows = (await this.prisma.forAccount(accountId).macro.findMany({
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true, definition: true },
    })) as { id: string; name: string; definition: unknown }[];
    // A stored definition is re-validated on read: a blob written by an older, looser version must
    // not be presented as if this version understood it.
    return rows.map((r) => ({ id: r.id, name: r.name, actions: safeActions(r.definition) }));
  }

  async create(accountId: string, name: string, actions: MacroAction[]): Promise<MacroRow> {
    const row = (await this.prisma.forAccount(accountId).macro.create({
      data: { account_id: accountId, name, definition: toDefinition(actions) as never },
      select: { id: true, name: true },
    })) as { id: string; name: string };
    return { id: row.id, name: row.name, actions };
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
    actions: MacroAction[],
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    const statements = actions.map((a) => {
      switch (a.type) {
        case 'MACRO_ACTION_TYPE_SET_STATUS':
          return db.conversation.updateMany({
            where: { id: conversationId },
            data: { status: statusFromWire(a.value) },
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
          return db.conversation.updateMany({
            where: { id: conversationId },
            data: { assignee_operator_id: a.value },
          });
      }
    });
    await db.$transaction(statements as never);
  }
}

/** Wire status name → storage scalar (the definition stores the wire name, research R4). */
function statusFromWire(wire: string): string {
  return wire.replace('CONVERSATION_STATUS_', '').toLowerCase();
}

/** Re-validate a stored definition; an unreadable blob yields no actions rather than a crash. */
function safeActions(definition: unknown): MacroAction[] {
  try {
    return parseDefinition(definition);
  } catch {
    return [];
  }
}
