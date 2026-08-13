import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { userActor } from '../transition/conversation-transitions';
import { toDetailWire } from '../shared/wire';
import { MAX_SUBJECT_LENGTH } from '../subject/subject.derive';
import { DomainEventPublisher } from '../events/events.publisher';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { StatusRepository } from '../status/status.repository';
import { ConversationRepository } from './conversation.repository';
import { MessageRepository } from '../message/message.repository';
import { PersonMembersClient, toPersonRpc } from '../person/person-members.client';
import {
  ChannelParticipantClient,
  IdentitySourceUnavailableError,
} from '../channel/participant.client';
import { OperatorIdentityClient } from '../shared/operator-identity.client';
import { PrismaService } from '../prisma.service';
import { inPortfolio, narrowsToPortfolio } from './portfolio-scope';

interface InitiateWire {
  brandId?: string;
  playerId?: string;
  subject?: string;
  body?: string;
}

/**
 * ⭐ W17 (subpoint 4.6) — WRITE FIRST: one button, one channel (email).
 *
 * ── What it is ───────────────────────────────────────────────────────────────────────────────────
 * The AM's outbound act: a new email-channel conversation attached to THEIR player, with its first
 * message already on its way. Creates the conversation and posts the message through the SAME
 * repositories the reply path uses — so the delivery intent, the outbox, the retry/backoff and the
 * never-log-the-recipient rules are all inherited rather than restated.
 *
 * ── The address, and the honest refusal ─────────────────────────────────────────────────────────
 * The product's only real address source today is a participant this player has already written
 * from (users' `GetPlayerEmailParticipant` — an OPAQUE handle; the address itself never enters this
 * service). A player who has never written and is not GR8-synced (5.4, unbuilt) has no address —
 * `no known address`, a labelled refusal the screen words, never a guess.
 *
 * ── The gate is the MODULE's key, and that is load-bearing ──────────────────────────────────────
 * `crm.vip.workspace`, not `crm.conversation.reply`. The reply key is every agent's, and the
 * portfolio narrowing only binds roles that HAVE portfolios — gating on reply would let a line
 * agent (never narrowed) write first to ANY customer, which is initiation as an anti-pitching
 * bypass. The module key is held by am/shift_am (+ administrators through ALL_KEYS), so writing
 * first belongs to exactly the people whose act it is.
 *
 * ── The portfolio rule, server-side (the block's invariant) ──────────────────────────────────────
 * Feature 030's predicate, reused not restated: a caller whose role narrows to their own portfolio
 * may initiate ONLY to a player attached to them — checked here with the same `narrowsToPortfolio`
 * + `inPortfolio` pair the conversation reads use, against the same `users` source, fail-closed.
 * Administrators (who hold `masked_pii`) are not narrowed, exactly as on reads.
 *
 * ── Ordering: everything that can refuse runs BEFORE the first write ─────────────────────────────
 * Portfolio → channel → address → status → THEN create + post. A failure between the create and the
 * post would leave a conversation without its first message; the validations above make that a
 * transport-failure-only case, accepted and visible rather than silently possible on every call.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class InitiateConversationController {
  constructor(
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(MessageRepository) private readonly messages: MessageRepository,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
    @Inject(PersonMembersClient) private readonly person: PersonMembersClient,
    @Inject(ChannelParticipantClient) private readonly participants: ChannelParticipantClient,
    @Inject(OperatorIdentityClient) private readonly operators: OperatorIdentityClient,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @GrpcMethod('ChatsWriteService', 'InitiateEmailConversation')
  @RequiresChatsPermission('crm.vip.workspace')
  async initiateEmailConversation(req: InitiateWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const brandId = (req.brandId ?? '').trim();
    const playerId = (req.playerId ?? '').trim();
    const subject = (req.subject ?? '').trim();
    const body = (req.body ?? '').trim();
    if (!brandId || !playerId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'brandId and playerId are required' });
    }
    if (!body) {
      // An initiation with nothing to say is not a message — and an empty first mail to a customer
      // is worse than a refusal here.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'body is required' });
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'subject too long' });
    }

    // ── 1. The portfolio rule (feature 030's predicate, reused) ──────────────────────────────────
    if (narrowsToPortfolio(metadata)) {
      let portfolio;
      try {
        // Fail closed: an unreachable users and "attached to nobody" must not be conflated — the
        // same rule the read path records at its portfolioScope.
        portfolio = await this.person.attachedPlayersOfCaller(metadata);
      } catch (err) {
        throw toPersonRpc(err);
      }
      if (!inPortfolio({ brand_id: brandId, player_id: playerId }, portfolio)) {
        // The pair is not theirs. NOT_FOUND rather than PERMISSION_DENIED would hide that the
        // capability exists; PERMISSION_DENIED is honest — writing first is exactly what their
        // role allows only within the portfolio.
        throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
      }
    }

    // ── 2. A brand with no enabled email channel cannot send — refused, never enqueued-to-nowhere
    // (the enqueue path SKIPS silently by design; an initiation must not lean on that silence).
    const channel = await this.prisma.forAccount(ctx.accountId).channel.findFirst({
      where: { brand_id: brandId, kind: 'email', enabled: true },
      select: { id: true },
    });
    if (!channel) {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'no email channel for this brand' });
    }

    // ── 3. The address — an opaque handle, or the labelled refusal ───────────────────────────────
    let participantId: string | null;
    try {
      participantId = await this.participants.playerEmailParticipant(ctx.accountId, brandId, playerId);
    } catch (err) {
      if (err instanceof IdentitySourceUnavailableError) {
        throw new RpcException({ code: GrpcStatus.UNAVAILABLE, message: 'identity source unavailable' });
      }
      throw err;
    }
    if (!participantId) {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'no known address for this player' });
    }

    // ── 4. The status: the account's own `open` default — the ticket is being WORKED by its
    // initiator, not waiting untouched (that is what `new` means). NULL = misconfigured account.
    const statusKey = await this.statuses.defaultKeyOfCategory(ctx.accountId, 'open');
    if (!statusKey) {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'no open status configured' });
    }

    // The initiator owns the thread they started; an unresolvable operator profile leaves it
    // unassigned rather than refusing — assignment is a convenience here, not the capability.
    const assignee = await this.operators.resolveCallerOperatorId(metadata).catch(() => null);

    const row = await this.conversations.create(ctx.accountId, {
      brandId,
      playerId,
      channel: 'email',
      status: statusKey,
      identityState: 'identified',
      channelParticipantId: participantId,
      assigneeOperatorId: assignee ?? undefined,
      // The AM chose these words: source `manual`, so the derivation window never overwrites them.
      ...(subject ? { subject, subjectSource: 'manual' as const } : {}),
    });

    // The first message — through the SAME path a reply takes, so the delivery intent lands in the
    // outbox inside the message's own transaction (feature 033's rule, inherited).
    await this.messages.post(
      ctx.accountId,
      {
        conversationId: row.id,
        authorType: 'operator',
        authorId: ctx.userId || null,
        body,
        isPrivate: false,
        mentions: [],
      },
      userActor(ctx.userId),
    );

    await this.events.conversationCreated(ctx.accountId, row.id);
    await this.realtime.conversation('conversation.created', ctx.accountId, row.id);

    const fresh = await this.conversations.getById(ctx.accountId, row.id);
    return toDetailWire(fresh ?? row);
  }
}
