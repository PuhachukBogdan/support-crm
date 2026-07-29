import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import {
  RuleDefinitionError,
  parseDefinition,
  type RuleDefinition,
} from './rule-definition';
import {
  AutomationsRepository,
  type AutomationRow,
  type AutomationRunRow,
} from './automations.repository';
import { AuditRepository } from '../audit/audit.repository';

interface DefinitionWire {
  trigger?: string;
  conditions?: { field?: string; op?: string; value?: string }[];
  actions?: { type?: string; value?: string }[];
}
interface CreateWire {
  name?: string;
  definition?: DefinitionWire;
  position?: number;
  active?: boolean;
}
interface UpdateWire {
  id?: string;
  name?: string;
  hasName?: boolean;
  definition?: DefinitionWire;
  hasDefinition?: boolean;
  position?: number;
  hasPosition?: boolean;
  active?: boolean;
  hasActive?: boolean;
}
interface ListWire {
  pageToken?: string;
  pageSize?: number;
}
interface ListRunsWire extends ListWire {
  automationId?: string;
  conversationId?: string;
}

const toWire = (r: AutomationRow) => {
  // A stored blob is re-validated on read: a definition written by an older, looser version must not
  // be presented as though this version understood it (the 013 ListMacros precedent).
  let definition: RuleDefinition | null = null;
  try {
    definition = parseDefinition(r.definition);
  } catch {
    definition = null;
  }
  return {
    id: r.id,
    name: r.name,
    active: r.active,
    position: r.position,
    revision: r.revision,
    authorUserId: r.author_user_id,
    definition: definition
      ? { trigger: definition.trigger, conditions: definition.conditions, actions: definition.actions }
      : { trigger: 'AUTOMATION_TRIGGER_UNSPECIFIED', conditions: [], actions: [] },
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
};

const toRunWire = (r: AutomationRunRow) => ({
  id: r.id,
  automationId: r.automation_id,
  automationRevision: r.automation_revision,
  conversationId: r.conversation_id,
  trigger: r.trigger,
  outcome: r.outcome,
  reason: r.reason ?? '',
  createdAt: r.created_at.toISOString(),
});

const invalid = (message: string) =>
  new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });

/**
 * Automation rule authoring + run-record reads (feature 014, US1 — roadmap 4.6).
 *
 * All five write/read routes need `crm.automations.manage`, enforced here at the service tier as well
 * as at the gateway (Principle II — a call that skips the gateway is still refused).
 *
 * The **author** is taken from the validated actor metadata, never from the request body: it is the
 * authority the rule will act with (FR-023), so letting a client name it would turn rule creation into
 * a privilege-escalation primitive. Brand scope is captured alongside it and is empty today (brands
 * are not populated anywhere yet — Brands service, Phase 5).
 *
 * This controller does **not** publish domain events. It authors rules; it does not change
 * conversations, so there is nothing for a rule to react to here.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class AutomationsController {
  constructor(
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  @GrpcMethod('ChatsReadService', 'ListAutomations')
  @RequiresChatsPermission('crm.automations.manage')
  async listAutomations(req: ListWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const { rows, nextCursor } = await this.automations.list(
      ctx.accountId,
      clampPageSize(req?.pageSize),
      this.cursor(req?.pageToken),
    );
    return {
      automations: rows.map(toWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }

  @GrpcMethod('ChatsReadService', 'ListAutomationRuns')
  @RequiresChatsPermission('crm.automations.manage')
  async listAutomationRuns(req: ListRunsWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const { rows, nextCursor } = await this.automations.listRuns(
      ctx.accountId,
      {
        automationId: (req?.automationId ?? '').trim() || undefined,
        conversationId: (req?.conversationId ?? '').trim() || undefined,
      },
      clampPageSize(req?.pageSize),
      this.cursor(req?.pageToken),
    );
    return { runs: rows.map(toRunWire), nextPageToken: nextCursor ? encodeCursor(nextCursor) : '' };
  }

  @GrpcMethod('ChatsWriteService', 'CreateAutomation')
  @RequiresChatsPermission('crm.automations.manage')
  async createAutomation(req: CreateWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const name = (req?.name ?? '').trim();
    if (!name) throw invalid('name is required');
    if (!ctx.userId) {
      // Without an author there is no authority to run with, so such a rule could only ever be
      // refused (FR-024). Refusing to create it is clearer than storing a rule that cannot work.
      throw invalid('author identity is required');
    }
    const definition = this.parse(req?.definition);

    try {
      const row = await this.automations.create(ctx.accountId, {
        name,
        definition,
        authorUserId: ctx.userId,
        position: Number.isFinite(req?.position) ? Math.max(0, Math.trunc(req!.position!)) : 0,
        active: req?.active ?? true,
      });
      return toWire(row);
    } catch {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'automation name already used',
      });
    }
  }

  @GrpcMethod('ChatsWriteService', 'UpdateAutomation')
  @RequiresChatsPermission('crm.automations.manage')
  async updateAutomation(req: UpdateWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const id = (req?.id ?? '').trim();
    if (!id) throw invalid('id is required');

    // Explicit presence flags: through proto-loader an absent scalar is indistinguishable from ""/0/
    // false, so without them "enable this rule" and "clear its name" would look identical.
    const patch: {
      name?: string;
      definition?: RuleDefinition;
      position?: number;
      active?: boolean;
    } = {};
    if (req?.hasName) {
      const name = (req.name ?? '').trim();
      if (!name) throw invalid('name must not be empty');
      patch.name = name;
    }
    if (req?.hasDefinition) patch.definition = this.parse(req.definition);
    if (req?.hasPosition) patch.position = Math.max(0, Math.trunc(req.position ?? 0));
    if (req?.hasActive) patch.active = req.active ?? false;

    let row: AutomationRow | null;
    try {
      row = await this.automations.update(ctx.accountId, id, patch);
    } catch {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'automation name already used',
      });
    }
    if (!row) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toWire(row);
  }

  @GrpcMethod('ChatsWriteService', 'DeleteAutomation')
  @RequiresChatsPermission('crm.automations.manage')
  async deleteAutomation(req: { id?: string }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const id = (req?.id ?? '').trim();
    if (!id) throw invalid('id is required');

    // Read FIRST. Deleting a rule that acts by itself is a sensitive act, so the delete and its audit entry
    // commit together (feature 015 / spec Q3) — but `deleteMany` reports 0 for an absent id while the
    // transaction still commits, so calling it blind would file an entry for a deletion that never happened.
    // A trail that records non-events is worse than one with a gap: a reader cannot tell them apart.
    const existing = await this.automations.getById(ctx.accountId, id);
    if (!existing) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    const removed = await this.automations.removeAudited(
      ctx.accountId,
      id,
      this.audit.statement(ctx.accountId, {
        action: 'automation.delete',
        actorUserId: ctx.userId,
        underPreview: ctx.underPreview,
        targetRef: id,
        // The rule's own operator-authored name — not customer data. Without it a reader sees an id and has
        // to go looking for a row that no longer exists.
        detail: { name: existing.name, revision: existing.revision },
      }),
    );
    if (removed === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return { ok: true };
  }

  private parse(definition: DefinitionWire | undefined): RuleDefinition {
    try {
      return parseDefinition(definition);
    } catch (err) {
      throw invalid(
        err instanceof RuleDefinitionError && err.message ? err.message : 'invalid rule definition',
      );
    }
  }

  private cursor(token: string | undefined) {
    try {
      return decodeCursor(token);
    } catch (err) {
      if (err instanceof InvalidCursorError) throw invalid('invalid page token');
      throw err;
    }
  }
}
