import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ChannelIntakeService } from './intake.service';

interface AcceptChannelDeliveryWire {
  channelKey?: string;
  rawBodyText?: string;
  signature?: string;
  receivedAt?: string | number;
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
  constructor(@Inject(ChannelIntakeService) private readonly intake: ChannelIntakeService) {}

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

    return {
      conversationId: outcome.conversationId,
      messageId: outcome.messageId,
      duplicate: outcome.duplicate,
      refusalClass: outcome.refusal ?? '',
    };
  }
}
