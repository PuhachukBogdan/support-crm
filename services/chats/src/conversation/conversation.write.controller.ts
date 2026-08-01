import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { userActor } from '../transition/conversation-transitions';
import { toDetailWire, wireToStatus, isValidStatusWire } from '../shared/wire';
import { MAX_SUBJECT_LENGTH } from '../subject/subject.derive';
import { DomainEventPublisher } from '../events/events.publisher';
import { ConversationRepository } from './conversation.repository';

interface CreateConversationRequestWire {
  brandId: string;
  playerId?: string;
  priority?: string;
  channel?: string;
  assigneeOperatorId?: string;
}
interface SetConversationStatusRequestWire {
  conversationId: string;
  status?: string;
}
interface SetConversationSubjectRequestWire {
  conversationId: string;
  subject?: string;
}

/**
 * ChatsWriteService — conversation writes (feature 012, US1). `CreateConversation` seeds/tests +
 * future channel ingress; `SetConversationStatus` is the 4.1 lifecycle change. Gated by
 * `crm.conversation.reply` at both tiers; account scope via `forAccount`; brand resource-checked (R3).
 *
 * Feature 014 publishes `conversation.created` and `conversation.status_changed` from here. Publishing
 * sits at the controller and nowhere else, so an automation's own status write emits nothing and
 * cannot cascade (FR-006 / research R4) — a self-satisfying rule is bounded by construction.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ConversationWriteController {
  constructor(
    @Inject(ConversationRepository) private readonly repo: ConversationRepository,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
  ) {}

  @GrpcMethod('ChatsWriteService', 'CreateConversation')
  @RequiresChatsPermission('crm.conversation.reply')
  async createConversation(req: CreateConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!req.brandId) {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const row = await this.repo.create(ctx.accountId, {
      brandId: req.brandId,
      playerId: req.playerId || undefined,
      priority: req.priority || undefined,
      channel: req.channel || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
    });
    await this.events.conversationCreated(ctx.accountId, row.id);
    // Re-read: a rule may have changed status/priority/assignee, and the caller should see the
    // conversation as it actually is now rather than as it was a moment before the rules ran.
    const fresh = await this.repo.getById(ctx.accountId, row.id);
    return toDetailWire(fresh ?? row);
  }

  @GrpcMethod('ChatsWriteService', 'SetConversationStatus')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationStatus(req: SetConversationStatusRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!isValidStatusWire(req.status)) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid status' });
    }
    // Resource-check the target's brand before mutating (no existence disclosure otherwise).
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    const newStatus = wireToStatus(req.status)!;
    // Feature 023: the human who did it, and one correlation id for this act. Note the deliberate
    // ordering below — the durable TRANSITION is written inside `setStatus`'s own transaction, while
    // `this.events.statusChanged` further down is the in-process automation trigger (feature 014),
    // which is a different thing entirely and is fire-and-observe rather than durable.
    const updated = await this.repo.setStatus(
      ctx.accountId,
      req.conversationId,
      newStatus,
      userActor(ctx.userId),
      metadata,
    );
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    await this.events.statusChanged(
      ctx.accountId,
      req.conversationId,
      newStatus,
      updated.updated_at,
    );
    const fresh = await this.repo.getById(ctx.accountId, req.conversationId);
    return toDetailWire(fresh ?? updated);
  }

  /**
   * A person names the conversation, and that LOCKS the title (feature 023, roadmap 4.18 — FR-022).
   *
   * ── No new permission key, deliberately ─────────────────────────────────────────────────────────
   * `crm.conversation.reply` already governs changing this conversation, and naming it is not a new
   * kind of authority — it exposes nothing, deletes nothing and changes no privilege. A key that gated
   * one field would be a key nobody remembers to assign, and the closed catalogue (ADR 0011) exists so
   * that adding one is a deliberate act rather than a reflex.
   *
   * ── No audit entry either, and the difficulty of placing one was the signal ─────────────────────
   * This was first drafted as an audit action, and then no honest class existed for it among
   * privilege / deletion / access / export / assignment / retention. ADR 0019 records SENSITIVE
   * actions; a title edit is a state change with an actor and a time, which is what the transition
   * store is for. One transition, no new audit class (data-model §4).
   *
   * ── Refused, not truncated ──────────────────────────────────────────────────────────────────────
   * An over-long title is an INVALID_ARGUMENT. Silently shortening it would store words the author did
   * not write, with no way for them to tell — and the derivation truncates only because a customer's
   * 4 000-character message was never meant as a title in the first place.
   */
  @GrpcMethod('ChatsWriteService', 'SetConversationSubject')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationSubject(req: SetConversationSubjectRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);

    const subject = (req.subject ?? '').replace(/\s+/gu, ' ').trim();
    if (!subject) {
      // Clearing a title is not an operation this offers: a conversation with a human-set title and no
      // text would be frozen at nothing, and the automated writers could never fill it again.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid subject' });
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      // Length only — the offending value is a human's words and never enters a message or a log.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'subject too long' });
    }

    // Resource-check the target's brand before mutating (no existence disclosure otherwise), exactly
    // as the status write above does.
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    const updated = await this.repo.setSubject(
      ctx.accountId,
      req.conversationId,
      subject,
      userActor(ctx.userId),
      metadata,
    );
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    // No `this.events.*` here: a title is a label for humans, not a trigger. Publishing it would let a
    // rule react to a rename, which is the cascade feature 014 bounded by construction.
    return toDetailWire(updated);
  }
}
