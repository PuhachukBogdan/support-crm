import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { ChannelRepository } from './channel.repository';
import { ChannelIntakeService } from './intake.service';

/** Read one metadata key as a string. The same helper every maintenance controller carries. */
function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

interface AcceptChannelDeliveryWire {
  channelKey?: string;
  rawBodyText?: string;
  signature?: string;
  receivedAt?: string | number;
}

interface AcceptInboundEmailWire {
  channelKey?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  fromAddress?: string;
  subject?: string;
  bodyText?: string;
  uploadIds?: string[];
  sentAt?: string | number;
}

/**
 * The channel ingress (feature 033, roadmap 6.1 — subpoint 2.1a).
 *
 * ── ⚠️ NO ACTOR CONTEXT, AND THAT IS THE POINT ───────────────────────────────────────────────────
 * Every other write handler in this service reads `x-actor-*` metadata and re-checks the caller's
 * permissions independently, so a call that skipped the gateway is refused. **This one has no actor to
 * read.** The caller is a stranger's HTTP request, and its authentication is the signature the intake
 * service verifies against the channel's own secret — which is why verification lives there and not in a
 * guard: a guard would have to read a permission that does not exist for a party that holds no session.
 *
 * That makes the signature the whole of the authorization for this path, and it is why FR-009's test
 * asserts that a refusal writes **nothing** rather than merely returning an error.
 *
 * ── Why the outcome is a response and not an exception ──────────────────────────────────────────
 * A refusal is data the gateway maps to a status code. Throwing would move the decision "what does a
 * forged signature mean" into an error handler, and a duplicate — which is a SUCCESS — would have to
 * travel as an error to reach the same place.
 */
@Controller()
export class ChannelIngressController {
  constructor(
    @Inject(ChannelIntakeService) private readonly intake: ChannelIntakeService,
    // Only `ResolveIntakeChannel` uses it. The intake paths deliberately do not: they hand the KEY to
    // the intake service, which resolves it as its own first step — the account must be decided in one
    // place, and that place is the service that then writes under it.
    @Inject(ChannelRepository) private readonly channels: ChannelRepository,
  ) {}

  @GrpcMethod('ChatsWriteService', 'AcceptChannelDelivery')
  async acceptChannelDelivery(req: AcceptChannelDeliveryWire) {
    const outcome = await this.intake.acceptApiDelivery({
      channelKey: req.channelKey ?? '',
      rawBodyText: req.rawBodyText ?? '',
      signature: req.signature,
      // The gateway's clock at receipt. Falling back to ours would let a delivery that sat in a queue
      // for an hour verify, which is exactly what the replay window exists to stop.
      receivedAt: Number(req.receivedAt ?? 0) || Math.floor(Date.now() / 1000),
    });

    return wire(outcome);
  }

  /**
   * ⭐ One message from a brand's mailbox (US2 — roadmap 6.4).
   *
   * ── Why this has no actor check either, and what authenticates it instead ───────────────────────
   * The caller is the worker's mailbox reader. Its authentication is **holding the mailbox credentials**:
   * nothing reaches this path without having been handed a message by an IMAP session we opened with
   * configured credentials, and no gateway route maps to it (`tests/gateway/route-scan` style guards
   * assert that for the maintenance surface; this rpc is likewise unmapped).
   *
   * ⚠️ Adding an `x-actor-kind: system` gate here would look like security and provide none — the metadata
   * is set by the caller, and a caller able to reach this port can set it. The real boundary is the
   * network: chats' gRPC port is not exposed outside the cluster, which is the same boundary every
   * maintenance rpc in the product relies on.
   *
   * ⚠️ **`fromAddress` is never logged in this file and is not stored by this service.** It is forwarded
   * to `users`, which owns contact values, and chats keeps only the opaque handle (FR-021b).
   */
  @GrpcMethod('ChatsWriteService', 'AcceptInboundEmail')
  async acceptInboundEmail(req: AcceptInboundEmailWire) {
    const outcome = await this.intake.acceptInboundEmail({
      channelKey: req.channelKey ?? '',
      messageId: req.messageId ?? '',
      inReplyTo: req.inReplyTo,
      // proto3 omits an empty repeated field, so an absent list genuinely means "no references".
      references: Array.isArray(req.references) ? req.references.map(String) : [],
      fromAddress: req.fromAddress ?? '',
      subject: req.subject ?? '',
      bodyText: req.bodyText ?? '',
      uploadIds: Array.isArray(req.uploadIds) ? req.uploadIds.map(String) : [],
      sentAt: Number(req.sentAt ?? 0) || undefined,
    });

    return wire(outcome);
  }

  /**
   * Which tenant owns a channel key (feature 033, roadmap 6.4).
   *
   * ⚠️ **This handler DOES check the actor kind, unlike the two above, and the difference is real.** The
   * intake paths are authenticated by a signature and by holding a mailbox; this one answers a question
   * *about our configuration* — which account and brand a key belongs to — and that is a maintenance
   * question with the same fencing as every other: system actor only, no gateway route.
   *
   * ⚠️ An unknown or disabled key answers with empty fields rather than an error, for the same reason the
   * HTTP edge answers 404 for both (FR-008). The reader reads an empty account as "not configured for
   * intake" and stays shut.
   */
  @GrpcMethod('ChatsMaintenanceService', 'ResolveIntakeChannel')
  async resolveIntakeChannel(req: { channelKey?: string }, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const channel = await this.channels.resolveByKey(req?.channelKey ?? '');
    if (!channel) return { accountId: '', brandId: '', kind: '' };
    return { accountId: channel.account_id, brandId: channel.brand_id, kind: channel.kind };
  }
}

/** The one response shape both intake paths answer with (contracts §2.1/§2.2). */
function wire(outcome: {
  conversationId: string;
  messageId: string;
  duplicate: boolean;
  refusal?: string;
}) {
  return {
    conversationId: outcome.conversationId,
    messageId: outcome.messageId,
    duplicate: outcome.duplicate,
    refusalClass: outcome.refusal ?? '',
  };
}
