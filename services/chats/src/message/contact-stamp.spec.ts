import { CONTACT_STAMP_COLUMNS, decideContactStamp } from './contact-stamp';

/**
 * Feature 022 (roadmap 4.13), T008 — **which messages count as contact, and which do not.**
 *
 * The card says "when did we last talk to this customer". Two kinds of message look like contact and
 * are not:
 *
 *  • a **private note** — staff writing to staff. The first-reply SLA clock already encodes this
 *    (`sla/first-reply.ts`: `decideStop(existing, isPublicReply)`, a note changes nothing), and this
 *    feature reuses the rule rather than restating it, so the product cannot end up holding two
 *    definitions of "we replied";
 *  • a **system** entry — machine output. "We last spoke on Tuesday" must not be satisfied by an
 *    automated note.
 *
 * The rule is pure and lives here alone, so the write path cannot apply a fifth interpretation.
 */
describe('decideContactStamp (feature 022 — the derivation rule)', () => {
  it('a customer message stamps the inbound column', () => {
    expect(decideContactStamp('player', false)).toBe('last_inbound_at');
  });

  it('a PUBLIC staff reply stamps the outbound column', () => {
    expect(decideContactStamp('operator', false)).toBe('last_outbound_at');
  });

  it('a PRIVATE note stamps NOTHING — it is not contact with the customer (SEC-13 / roadmap 4.7)', () => {
    expect(decideContactStamp('operator', true)).toBeNull();
  });

  it('a system entry stamps NOTHING — machine output is not a conversation', () => {
    expect(decideContactStamp('system', false)).toBeNull();
    // Belt and braces: `private` must not smuggle a system entry into a column either.
    expect(decideContactStamp('system', true)).toBeNull();
  });

  it('an inbound message flagged private stamps nothing — a customer cannot write a private note', () => {
    // Not reachable today (`RecordIncomingMessage` hard-codes `isPrivate: false`), and that is exactly
    // why it is pinned: if a channel ever sets the flag, silently counting it as customer contact would
    // put a row the customer projection excludes onto the card as "they wrote to us".
    expect(decideContactStamp('player', true)).toBeNull();
  });

  it('an unknown author type stamps nothing (fail-closed, never a guessed column)', () => {
    expect(decideContactStamp('bot', false)).toBeNull();
    expect(decideContactStamp('', false)).toBeNull();
  });

  it('the two column names are the only ones this rule can ever return', () => {
    // Pins the return domain, so a later "helpful" third column cannot appear without this failing:
    // every read in the feature aggregates exactly these two.
    expect([...CONTACT_STAMP_COLUMNS].sort()).toEqual(['last_inbound_at', 'last_outbound_at']);
    for (const authorType of ['player', 'operator', 'system', 'bot']) {
      for (const isPrivate of [true, false]) {
        const column = decideContactStamp(authorType, isPrivate);
        expect(column === null || CONTACT_STAMP_COLUMNS.includes(column)).toBe(true);
      }
    }
  });
});
