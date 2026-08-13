import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { hasPermission } from '@crm/common';
import { ChatsAccessGuard, readActorPermissions } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { userActor } from '../transition/conversation-transitions';
import { toDetailWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';
import { LabelsRepository } from '../labels/labels.repository';
import { StatusRepository } from '../status/status.repository';
import { MacrosRepository, type MacroRow } from './macros.repository';
import {
  MacroDefinitionError,
  parseActions,
  parseDefinition,
  requiredPermissions,
} from './macro-definition';

interface DefineMacroRequestWire {
  name?: string;
  actions?: { type?: string; value?: string }[];
}
interface ApplyMacroRequestWire {
  conversationId?: string;
  macroId?: string;
}

const toMacroWire = (m: MacroRow) => ({ id: m.id, name: m.name, actions: m.actions });

/**
 * Macros (feature 013, US2 — roadmap 4.5). Authoring (`DefineMacro`/`ListMacros`) needs
 * `crm.templates.manage`; APPLYING needs `crm.macros.use` **plus** the permission each individual
 * action would require on its own — bundling actions must never bypass a permission the caller
 * lacks (Principle II / SC-004/SC-005).
 *
 * Apply is all-or-nothing (FR-008). Two layers give that: every check (permissions, conversation
 * access, label existence) happens **before** any write, and the writes themselves run in a single
 * `$transaction`. A refused macro therefore leaves **zero** changes — not a rolled-back attempt.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class MacrosController {
  constructor(
    @Inject(MacrosRepository) private readonly macros: MacrosRepository,
    @Inject(LabelsRepository) private readonly labels: LabelsRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    // Feature 032: a macro's SET_STATUS value is validated against THIS account's configured statuses.
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  @GrpcMethod('ChatsReadService', 'ListMacros')
  // W8 (2026-08-06): LISTING dropped from `crm.templates.manage` to `crm.macros.use` — reading the
  // list is the first half of USING one, and every agent role holds the use key while none held
  // manage, so the ticket window's «Apply macro» had nothing to offer its intended user. Widens no
  // capability: applying still re-checks the permission of every action in the bundle, and
  // AUTHORING (DefineMacro below) stays a lead-level configuration task.
  @RequiresChatsPermission('crm.macros.use')
  async listMacros(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.macros.list(ctx.accountId);
    return { macros: rows.map(toMacroWire) };
  }

  @GrpcMethod('ChatsWriteService', 'DefineMacro')
  @RequiresChatsPermission('crm.templates.manage')
  async defineMacro(req: DefineMacroRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const name = (req.name ?? '').trim();
    if (!name) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'name is required' });
    }
    let actions;
    try {
      // Unknown action types are rejected HERE, at define time (research R4) — and, since feature 032,
      // so is a status this account has not configured or has retired.
      actions = parseActions(req.actions, await this.statuses.activeKeys(ctx.accountId));
    } catch (err) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: err instanceof MacroDefinitionError ? err.message : 'invalid macro definition',
      });
    }
    try {
      const row = await this.macros.create(ctx.accountId, name, actions);
      return toMacroWire(row);
    } catch {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'macro name already used',
      });
    }
  }

  @GrpcMethod('ChatsWriteService', 'ApplyMacro')
  @RequiresChatsPermission('crm.macros.use')
  async applyMacro(req: ApplyMacroRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    const macroId = (req.macroId ?? '').trim();
    if (!conversationId || !macroId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversation_id and macro_id are required',
      });
    }

    // 1. The macro must exist in THIS account.
    const macro = await this.macros.getById(ctx.accountId, macroId);
    if (!macro) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    // 2. Re-validate the stored definition (it may predate this code — research R4).
    let actions;
    try {
      // Feature 032: re-validated against the CURRENT catalogue, which is what makes retiring a status
      // stop the macros that used it rather than leaving them to write a word nothing resolves.
      actions = parseDefinition(macro.definition, await this.statuses.activeKeys(ctx.accountId));
    } catch {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'macro definition is not applicable',
      });
    }

    // 3. Per-action permissions BEFORE any write: a blocked action refuses the WHOLE macro and
    //    writes nothing (SC-004) — the conversation is never left half-changed.
    const perms = readActorPermissions(metadata);
    for (const key of requiredPermissions(actions)) {
      if (!hasPermission(perms, key)) {
        throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
      }
    }

    // 4. The target conversation must be in the account and a permitted brand.
    const conversation = await this.conversations.getById(ctx.accountId, conversationId);
    if (!conversation) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    // 5. Every label referenced by an ADD_LABEL action must exist in the account — validated up
    //    front so the transaction cannot fail halfway on a foreign label id.
    for (const a of actions) {
      if (a.type === 'MACRO_ACTION_TYPE_ADD_LABEL') {
        if (!(await this.labels.exists(ctx.accountId, a.value))) {
          throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
        }
      }
    }

    // 6. All actions in ONE transaction (FR-008).
    // Feature 023: a macro is an explicit HUMAN action (U9) — the agent invoked it deliberately, so
    // the transition names them, not the macro.
    await this.macros.applyActions(ctx.accountId, conversationId, actions, userActor(ctx.userId));

    const updated = await this.conversations.getById(ctx.accountId, conversationId);
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toDetailWire(updated);
  }
}
