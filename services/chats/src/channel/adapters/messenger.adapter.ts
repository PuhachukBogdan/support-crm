import { Injectable } from '@nestjs/common';
import type { ChannelKind } from '@crm/common';
import type {
  ChannelAdapter,
  NormaliseResult,
  OutboundPayload,
  AdapterSendResult,
} from './adapter.contract';

/**
 * The messenger adapter (feature 033, roadmap 6.6 — T073, subpoint 2.1e).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THIS ADAPTER CARRIES NOTHING, AND SAYING SO IS ITS ENTIRE JOB.**
 *
 * The kind and the contract ship in the MVP; the transport does not (`2.1i` waits on the vendor
 * question `O1`). What that buys is real: the Inbox filter, the analytics split, the SLA dimension and
 * the capability matrix all have a third value to stand on TODAY, so connecting a messenger later adds a
 * transport rather than a concept — and nothing downstream has to learn a new word.
 *
 * ── The two failures this shape exists to prevent (FR-007) ──────────────────────────────────────
 *  1. **A crash.** Throwing would tell the caller the product is broken when it is merely incapable, and
 *     an unhandled rejection on a send path takes the batch with it.
 *  2. **A silent no-op.** Returning success and doing nothing loses a customer's reply with no symptom
 *     until they ask why nobody answered — days later, from the customer rather than from a log.
 *
 * So both methods answer with a **verdict**. That is why `ChannelAdapter.send` returns a result rather
 * than a void promise, and why `normalise` has a refusal vocabulary at all.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⓘ **The send path never reaches here**, and that is by design rather than by luck: `canSend` refuses
 * `messenger` with `no_transport` before an adapter is chosen (`outbound.service.ts`). This is the
 * backstop for a caller that skipped the gate — the same relationship `api.adapter.ts` has with its own
 * refusal.
 */
@Injectable()
export class MessengerChannelAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = 'messenger';
  /**
   * ⚠️ **TRUE, and deliberately not `false`.** The platforms carry files — WhatsApp and Telegram both do,
   * and the capability matrix records it as a fact about the KIND (roadmap 6.6). This flag answers *can
   * files travel on this kind*, not *is it connected*; the second question is `outboundTransport`, and
   * conflating the two is exactly the defect US4 had to correct one layer up.
   */
  readonly supportsAttachments = true;

  /**
   * There is no inbound transport, so there is nothing to normalise.
   *
   * ⚠️ `unparseable` rather than a new refusal class. A message arriving here at all means something is
   * misrouted — no mailbox, no webhook and no vendor connection exists for this kind — and inventing a
   * class for a state that cannot occur would put a value in the vocabulary that nothing can produce.
   */
  normalise(): NormaliseResult {
    return { ok: false, refusal: 'unparseable' };
  }

  /**
   * States that it cannot send. Never throws, never silently succeeds.
   *
   * The refusal is `not_supported`, which is the adapter vocabulary's word for *this build has no
   * transport for this kind* — distinct from `transport_failed`, which means one was reached and refused.
   * A reader of a dead-lettered row must be able to tell "we cannot do this" from "it did not work".
   */
  async send(payload: OutboundPayload): Promise<AdapterSendResult> {
    // Named rather than underscored so the signature reads as the contract's, and referenced in nothing:
    // there is no transport to hand it to.
    void payload;
    return { ok: false, refusal: 'not_supported' };
  }
}
