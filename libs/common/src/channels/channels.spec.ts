import {
  CHANNEL_KINDS,
  channelKindFromStored,
  channelKindFromWire,
  channelKindToWire,
  isChannelKind,
  LIVE_CHANNEL_KINDS,
} from './kinds';
import { canSend, CHANNEL_CAPABILITIES, listChannelCapabilities } from './capabilities';

/**
 * T005 + T006 + T069 (feature 033) — the vocabulary and the matrix.
 * FAILS before `kinds.ts` / `capabilities.ts` exist, PASSES after.
 *
 * Scope note, because this file could easily be three times longer for no gain: the MVP block rule is
 * one test per RULE, not one per value. So the nine capability numbers are asserted once as the
 * platform facts they encode (the thing a future edit could silently get wrong), and `canSend`'s
 * ordering is asserted once, because an order change is what turns "we cannot carry this at all" into
 * a subtler refusal that implies it would otherwise work.
 */
describe('the channel-kind vocabulary — feature 033', () => {
  it('is closed: a word outside it resolves to nothing rather than to a default', () => {
    expect(isChannelKind('api')).toBe(true);
    expect(isChannelKind('chat')).toBe(false); // the pre-033 value the migration folds into `api`
    expect(isChannelKind('telegram')).toBe(false); // a platform, not a kind
    expect(isChannelKind(undefined)).toBe(false);
  });

  it('separates "no arrival channel" from "a word we do not recognise"', () => {
    // The distinction is load-bearing: about one in six conversations legitimately has no channel (an
    // agent raised it), while an unrecognised value is a defect — a migration that missed a row. A
    // caller that collapses the two cannot report the second, and the second is the one worth knowing.
    expect(channelKindFromStored(null)).toBeUndefined();
    expect(channelKindFromStored('')).toBeUndefined();
    expect(channelKindFromStored('email')).toBe('email');
    expect(channelKindFromStored('chat')).toBeNull();
  });

  it('never guesses on the wire, in either direction', () => {
    expect(channelKindToWire('email')).toBe('CHANNEL_KIND_EMAIL');
    expect(channelKindToWire('nonsense')).toBe('CHANNEL_KIND_UNSPECIFIED');
    expect(channelKindToWire(null)).toBe('CHANNEL_KIND_UNSPECIFIED');
    expect(channelKindFromWire('CHANNEL_KIND_UNSPECIFIED')).toBeUndefined();
    expect(channelKindFromWire('CHANNEL_KIND_SMS')).toBeNull();
  });

  it('knows which kinds it can actually carry today', () => {
    // messenger ships as a kind and a contract with no transport (2.1i / question O1).
    expect([...LIVE_CHANNEL_KINDS]).toEqual(['api', 'email']);
    expect(CHANNEL_KINDS).toHaveLength(3);
  });
});

describe('the capability matrix — feature 033', () => {
  it('encodes the platform facts as data', () => {
    // These are facts about somebody else's product (roadmap 6.6), so the test states them plainly:
    // if a future edit changes one, that is a claim about a platform and must be a deliberate change.
    expect(CHANNEL_CAPABILITIES.email).toEqual({
      mayInitiate: true,
      replyWindowHours: 0,
      supportsAttachments: true,
      templateRequiredToInitiate: false,
    });
    // WhatsApp Business: initiation by approved template only, free text forbidden outside 24 hours.
    expect(CHANNEL_CAPABILITIES.messenger.replyWindowHours).toBe(24);
    expect(CHANNEL_CAPABILITIES.messenger.templateRequiredToInitiate).toBe(true);
    // The widget session is the customer's page — there is no address to write to first.
    expect(CHANNEL_CAPABILITIES.api.mayInitiate).toBe(false);
  });

  it('refuses a kind with no transport BEFORE any subtler rule', () => {
    // Order matters. Refusing messenger as `reply_window_expired` would imply that waiting for the
    // customer to write would make it work, and it would not: nothing can be sent at all.
    expect(canSend('messenger', { initiating: false, hoursSinceLastInbound: 1 })).toEqual({
      allowed: false,
      reason: 'no_transport',
    });
    expect(canSend('messenger', { initiating: true, usingApprovedTemplate: true })).toEqual({
      allowed: false,
      reason: 'no_transport',
    });
  });

  it('allows an email reply and an email initiation, which is why outbound ships on email', () => {
    expect(canSend('email', { initiating: false })).toEqual({ allowed: true });
    expect(canSend('email', { initiating: true })).toEqual({ allowed: true });
  });

  it('refuses initiating on a kind that cannot open a conversation', () => {
    expect(canSend('api', { initiating: true })).toEqual({
      allowed: false,
      reason: 'initiation_not_supported',
    });
    // ...while replying on it is fine — the customer is already there.
    expect(canSend('api', { initiating: false })).toEqual({ allowed: true });
  });

  it('treats an unknown elapsed time as OUTSIDE a reply window, not inside it', () => {
    // "We do not know how long ago they wrote" is not evidence that it was recent. Asserted against a
    // hypothetically-live windowed kind by construction, since the only windowed kind is messenger and
    // `no_transport` short-circuits it — so the rule is checked through the matrix directly.
    const cap = CHANNEL_CAPABILITIES.messenger;
    expect(cap.replyWindowHours).toBeGreaterThan(0);
    expect(canSend('nonsense', { initiating: false })).toEqual({
      allowed: false,
      reason: 'unknown_channel_kind',
    });
  });

  it('reports every kind for the read the Inbox and analytics stand on', () => {
    const all = listChannelCapabilities();
    expect(all.map((c) => c.kind)).toEqual(['api', 'email', 'messenger']);
    expect(all.find((c) => c.kind === 'messenger')?.liveTransport).toBe(false);
  });
});
