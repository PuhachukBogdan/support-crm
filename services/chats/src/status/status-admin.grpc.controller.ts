import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { isStatusCategory } from '@crm/common';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { AuditRepository } from '../audit/audit.repository';
import { StatusRepository, toStatusDefWire } from './status.repository';

interface CreateStatusWire {
  category?: string;
  agentName?: string;
  endUserName?: string;
}
interface UpdateStatusWire {
  key?: string;
  agentName?: string;
  endUserName?: string;
  category?: string;
  setActive?: boolean;
  active?: boolean;
}

/** A label is a word or two an agent reads on a row; longer is prose, and prose is not a name. */
const MAX_NAME = 80;

/**
 * The key, derived from the agent-facing name — lowercased word characters, runs of anything else
 * collapsed to `_`. NEVER chosen by the caller: it is what the conversation FK stands on, it is
 * immutable, and letting a caller spell it invites a silent collision with the seeded vocabulary
 * (which the unique constraint would catch, but a derivation makes the rule visible on the screen:
 * the key IS the name, normalised).
 */
function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Shared refusals for the two text names. Both are REQUIRED on create (dual naming cannot be
 *  retrofitted from data — the model's own rule), optional-but-nonempty on update. The message is
 *  the caller's LITERAL: an interpolated message is the shape the no-pii-logs guard forbids, and a
 *  message built from parts is one refactor away from carrying a value. */
function assertName(message: string, value: string): void {
  if (!value || value.length > MAX_NAME) {
    throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
  }
}

/**
 * ⭐ W15a (subpoint 3.14 — O6 reversed R21) — the status authoring writes.
 *
 * ── What feature 032 promised, delivered ─────────────────────────────────────────────────────────
 * The two-level model (six CATEGORIES in code, statuses as per-account rows) was built precisely so
 * this screen would be an INSERT/UPDATE and not a migration. Nothing here touches a category's
 * meaning: a new status lands in an existing category and every bucket, filter, counter and
 * automation picks it up because they all read categories — the no-status-key-branch guarantee.
 *
 * ── `platform.settings.manage`, like the channels surface ────────────────────────────────────────
 * The status vocabulary is tenant configuration: a category change re-files tickets in every bucket
 * and report, retirement changes what agents may set. Same key, same holders (admin + super-admin),
 * same two-tier enforcement, and every write audited (`status.config_changed`) in its own
 * transaction.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────────────────────
 * DELETE (retirement is `active: false` — old tickets keep their label, ON DELETE RESTRICT stands
 * behind it), key editing (the FK's identity), and reordering (the seed's by-tens `order` is
 * display-only; a reorder control is not in 3.14's minimum).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class StatusAdminController {
  constructor(
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  @GrpcMethod('ChatsWriteService', 'CreateConversationStatus')
  @RequiresChatsPermission('platform.settings.manage')
  async createConversationStatus(req: CreateStatusWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const category = (req.category ?? '').trim();
    const agentName = (req.agentName ?? '').trim();
    const endUserName = (req.endUserName ?? '').trim();
    if (!isStatusCategory(category)) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'unknown category' });
    }
    assertName('invalid agent name', agentName);
    assertName('invalid end-user name', endUserName);
    const key = keyFromName(agentName);
    if (!key) {
      // A name of punctuation yields no key; refused rather than given a generated one — the key is
      // the name normalised, and a key unrelated to the name would be unreadable in every filter.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'agent name yields no key' });
    }

    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'status.config_changed',
      targetRef: key,
    });

    try {
      await this.statuses.createDefinition(ctx.accountId, { key, category, agentName, endUserName }, statement);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        // The derived key collides with an existing status (seeded or custom, active or retired).
        // Said as a conflict, so the screen can tell the person to pick a different name.
        throw new RpcException({ code: GrpcStatus.ALREADY_EXISTS, message: 'a status with this name already exists' });
      }
      throw e;
    }

    const fresh = await this.statuses.byKey(ctx.accountId, key);
    if (!fresh) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toStatusDefWire(fresh);
  }

  @GrpcMethod('ChatsWriteService', 'UpdateConversationStatus')
  @RequiresChatsPermission('platform.settings.manage')
  async updateConversationStatus(req: UpdateStatusWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const key = (req.key ?? '').trim();
    if (!key) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'key is required' });
    }
    const existing = await this.statuses.byKey(ctx.accountId, key);
    if (!existing) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    // Only what was sent, and only what differs. proto3 empty string = "unchanged" for the text
    // fields; `setActive` is the explicit marker a bare bool cannot carry.
    const patch: { agent_name?: string; end_user_name?: string; category?: string; active?: boolean } = {};
    const agentName = (req.agentName ?? '').trim();
    const endUserName = (req.endUserName ?? '').trim();
    const category = (req.category ?? '').trim();
    if (agentName && agentName !== existing.agent_name) {
      assertName('invalid agent name', agentName);
      patch.agent_name = agentName;
    }
    if (endUserName && endUserName !== existing.end_user_name) {
      assertName('invalid end-user name', endUserName);
      patch.end_user_name = endUserName;
    }
    if (category && category !== existing.category) {
      if (!isStatusCategory(category)) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'unknown category' });
      }
      patch.category = category;
    }
    if (req.setActive === true && req.active !== existing.active) {
      patch.active = req.active === true;
    }
    if (Object.keys(patch).length === 0) {
      // The audit entry is half the point; an entry recording no change is noise in the store that
      // exists to be read (the setBrand / channel no-op rule).
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'nothing to change' });
    }

    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'status.config_changed',
      targetRef: key,
    });

    const count = await this.statuses.updateDefinition(ctx.accountId, key, patch, statement);
    if (count === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    const fresh = await this.statuses.byKey(ctx.accountId, key);
    if (!fresh) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toStatusDefWire(fresh);
  }
}
