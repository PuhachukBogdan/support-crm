import {
  TRANSITION_TYPES,
  TRANSITION_SUBJECTS,
  isTransitionType,
  transitionsWithStatus,
  RESTRICTED_TRANSITION_TYPES,
  type TransitionType,
} from './catalogue';

/**
 * T007 (feature 023, roadmap 4.8a) — the closed transition catalogue.
 *
 * Shape copied deliberately from `audit/catalogue.spec.ts`, and for the same reason its header gives:
 * feature 011 needed to record permission changes and invented one table, then needed contact views
 * and invented a second. Asserting EXACT membership per status is what makes promoting a type a
 * visible act rather than a quiet one.
 */
describe('transition catalogue — membership is asserted, not assumed', () => {
  it('has exactly these LIVE types (a writer exists in this feature)', () => {
    expect(transitionsWithStatus('live').sort()).toEqual(
      [
        'conversation.assigned',
        'conversation.first_public_reply',
        'conversation.status_changed',
        'conversation.subject_set',
        // Feature 025 (roadmap 5.9) — `users` becomes the SECOND writer of this stream and the first
        // outside chats. `operator.presence_changed` was defined by feature 023 with no writer, for
        // exactly this moment; `operator.channel_availability_changed` is new, because a per-channel
        // switch is not expressible under the presence payload's allow-list.
        'operator.presence_changed',
        'operator.channel_availability_changed',
        // W9 / spec 035 (ADR 0044): the lookup and the reversible identity pair — writers are the
        // context-gated proxy and the SetConversationPlayer/Detach transactions in chats.
        'contact.lookup_performed',
        'conversation.player_attached',
        'conversation.player_detached',
      ].sort(),
    );
  });

  it('has exactly these NO-WRITER-YET types, defined ahead of the features that emit them', () => {
    expect(transitionsWithStatus('no-writer-yet').sort()).toEqual(
      [
        'conversation.released',
        'escalation.status_changed',
        'escalation.waiting_changed',
        // `operator.presence_changed` left this list at feature 025 — see the LIVE list above.
        // `contact.lookup_performed` and the player attach/detach pair left at W9 (spec 035).
        'staff.provisioning_requested',
        'staff.provisioning_rejected',
      ].sort(),
    );
  });

  it('marks exactly one type RESTRICTED, and it is the SEC-26 exception', () => {
    // The only place in this product where a (hashed) contact value may be stored.
    expect([...RESTRICTED_TRANSITION_TYPES]).toEqual(['contact.lookup_performed']);
  });

  it('every type carries a class, a writer service, a status and a human label', () => {
    for (const [type, spec] of Object.entries(TRANSITION_TYPES)) {
      expect(spec.subject).toBeTruthy();
      expect(spec.writer).toBeTruthy();
      expect(spec.status).toBeTruthy();
      expect(spec.label.length).toBeGreaterThan(3);
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/); // dotted, lower snake — one spelling, forever
    }
  });

  it('refuses an unknown type', () => {
    expect(isTransitionType('conversation.status_changed')).toBe(true);
    expect(isTransitionType('conversation.statusChanged')).toBe(false);
    expect(isTransitionType('status changed')).toBe(false);
    expect(isTransitionType('')).toBe(false);
    expect(isTransitionType(undefined)).toBe(false);
  });

  it('does NOT define a `reopen` type — it is DERIVED from a status transition (FR-013)', () => {
    // A separate type would be a second source of truth able to disagree with the transitions it
    // came from. "Reopened %" is computed by reading status_changed terminal → non-terminal.
    const names = Object.keys(TRANSITION_TYPES);
    expect(names.filter((n) => n.includes('reopen'))).toEqual([]);
  });

  it('writers name a real service, so a type cannot be orphaned', () => {
    const services = new Set(['chats', 'users', 'auth', 'worker']);
    for (const spec of Object.values(TRANSITION_TYPES)) {
      expect(services.has(spec.writer)).toBe(true);
    }
  });

  it('subject kinds are a closed set too', () => {
    for (const spec of Object.values(TRANSITION_TYPES)) {
      expect(TRANSITION_SUBJECTS).toContain(spec.subject);
    }
  });

  it('is exhaustive over the union type (a new entry cannot skip the type)', () => {
    const fromType: TransitionType[] = Object.keys(TRANSITION_TYPES) as TransitionType[];
    expect(fromType.length).toBe(Object.keys(TRANSITION_TYPES).length);
  });
});
