import { canSend, CHANNEL_KINDS, listChannelCapabilities } from '@crm/common';
import { MessengerChannelAdapter } from './adapters/messenger.adapter';
import { ChannelCapabilitiesController } from './capabilities.grpc.controller';

/**
 * T070/T071/T073/T074 (feature 033, US5 — subpoint 2.1e) — **a kind that cannot carry a message says so.**
 * FAILS before `messenger.adapter.ts` and `capabilities.grpc.controller.ts` exist, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THE TWO FAILURES THIS STORY EXISTS TO PREVENT** (FR-007):
 *
 *  · **a crash** — telling the caller the product is broken when it is merely incapable, and taking the
 *    rest of the batch down with an unhandled rejection;
 *  · **a silent no-op** — returning success and doing nothing, which loses a customer's reply with no
 *    symptom at all until they ask why nobody answered, days later, from their side rather than ours.
 *
 * Both are avoided the same way: the answer is a **verdict**, at every layer that could be asked.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

describe('the refusal is a verdict, not a crash and not a silence (FR-007)', () => {
  it('the adapter STATES that it cannot send, and returns rather than throws', async () => {
    const adapter = new MessengerChannelAdapter();
    const result = await adapter.send({
      to: 'irrelevant',
      subject: 'irrelevant',
      body: 'ответ агента',
      externalMessageId: '<x@y>',
    });
    expect(result).toEqual({ ok: false, refusal: 'not_supported' });
  });

  it('and has nothing to normalise either — a message here means something is misrouted', () => {
    expect(new MessengerChannelAdapter().normalise()).toEqual({
      ok: false,
      refusal: 'unparseable',
    });
  });

  it('⚠️ `supportsAttachments` is TRUE — it answers a different question from "is it connected"', () => {
    // The platforms carry files; the matrix records that as a fact about the KIND. Whether we can reach
    // them at all is `outboundTransport`, and conflating the two is precisely the defect US4 corrected.
    expect(new MessengerChannelAdapter().supportsAttachments).toBe(true);
  });
});

describe('enforcement is SERVER-SIDE, before an adapter is even chosen (FR-006)', () => {
  it('`canSend` refuses messenger in both directions with an actionable class', () => {
    // ⚠️ This is the gate the send path actually reads (`outbound.service.ts`), so a request that bypassed
    // every interface still gets the same answer. An interface that merely hid a reply box would leave the
    // path reachable — which is the distinction between enforcement and decoration.
    for (const initiating of [true, false]) {
      expect(canSend('messenger', { initiating })).toEqual({
        allowed: false,
        reason: 'no_transport',
      });
    }
  });

  it('`no_transport` is answered BEFORE any subtler rule', () => {
    // Messenger also has a 24-hour reply window and a template requirement. A kind we cannot carry at all
    // must not be refused for one of those instead: `reply_window_expired` would send somebody looking for
    // a customer who wrote too long ago, and there is no window to be outside of.
    expect(canSend('messenger', { initiating: false, hoursSinceLastInbound: 999 }).allowed).toBe(false);
    expect(canSend('messenger', { initiating: false, hoursSinceLastInbound: 1 })).toEqual({
      allowed: false,
      reason: 'no_transport',
    });
  });

  it('an unknown kind is refused too — a typo is not a permission', () => {
    expect(canSend('telegram', { initiating: false })).toEqual({
      allowed: false,
      reason: 'unknown_channel_kind',
    });
    expect(canSend(null, { initiating: false }).allowed).toBe(false);
  });
});

describe('the capability read every later block stands on (T074)', () => {
  const rows = new ChannelCapabilitiesController().getChannelCapabilities().capabilities;

  it('answers for EVERY kind, so a consumer never has to guess about one', () => {
    expect(rows).toHaveLength(CHANNEL_KINDS.length);
    expect(rows.map((r) => r.kind)).toEqual([
      'CHANNEL_KIND_API',
      'CHANNEL_KIND_EMAIL',
      'CHANNEL_KIND_MESSENGER',
    ]);
  });

  it('carries the roadmap 6.6 platform facts as DATA, both transport directions included', () => {
    const by = (wire: string) => rows.find((r) => r.kind === wire)!;

    // Email: the one kind that carries a message both ways, which is why outbound initiation ships on it.
    expect(by('CHANNEL_KIND_EMAIL')).toMatchObject({
      mayInitiate: true,
      replyWindowHours: 0,
      liveTransport: true,
      outboundTransport: true,
    });

    // ⭐ API: connected and taking work in every day, and unable to carry anything out. The two booleans
    // disagreeing is the whole reason the second one exists (US4).
    expect(by('CHANNEL_KIND_API')).toMatchObject({
      mayInitiate: false,
      liveTransport: true,
      outboundTransport: false,
    });

    // Messenger: the contract ships, the transport does not. The 24-hour window and the template rule are
    // recorded now so connecting a vendor later adds a transport rather than a concept.
    expect(by('CHANNEL_KIND_MESSENGER')).toMatchObject({
      replyWindowHours: 24,
      templateRequiredToInitiate: true,
      liveTransport: false,
      outboundTransport: false,
    });
  });

  it('the controller is a pure projection of the matrix — no second copy of the facts', () => {
    // If the handler ever started deciding anything, the matrix would stop being the single source of
    // truth it exists to be. Asserted by comparing against the library directly.
    expect(rows.map((r) => r.replyWindowHours)).toEqual(
      listChannelCapabilities().map((c) => c.replyWindowHours),
    );
  });
});
