import { assertTransitionPayload, TransitionPayloadError } from './payload';

/**
 * T008 (feature 023, roadmap 4.8a) — the per-type payload allow-list.
 *
 * The technique is feature 015's and it is the point of the whole file: PII must be **inexpressible**
 * here, not merely discouraged. An allow-list refuses an unknown key, so "someone adds `body` to the
 * payload one day" fails a test instead of quietly putting customer text into an append-only store.
 */
const ok = (type: string, payload: unknown) => () => assertTransitionPayload(type, payload);

describe('transition payload allow-list — PII is inexpressible', () => {
  it('accepts the exact shape each live type declares', () => {
    expect(ok('conversation.status_changed', { from: 'open', to: 'resolved' })).not.toThrow();
    expect(ok('conversation.assigned', { from: null, to: 'op-1' })).not.toThrow();
    expect(ok('conversation.first_public_reply', { messageId: 'm-1' })).not.toThrow();
  });

  it('accepts an omitted optional key but refuses an unknown one', () => {
    expect(ok('conversation.assigned', { to: 'op-1' })).not.toThrow();
    expect(ok('conversation.status_changed', { from: 'open', to: 'resolved', why: 'x' })).toThrow(
      TransitionPayloadError,
    );
  });

  // ── The four things that must never be storable, one test each so a failure names the culprit ──

  it('REFUSES a message body', () => {
    expect(ok('conversation.first_public_reply', { messageId: 'm-1', body: 'hello' })).toThrow(
      TransitionPayloadError,
    );
  });

  it('REFUSES a contact value', () => {
    expect(ok('conversation.status_changed', { from: 'open', to: 'x', email: 'a@b.c' })).toThrow(
      TransitionPayloadError,
    );
    expect(ok('conversation.status_changed', { from: 'open', to: 'x', phone: '+123' })).toThrow(
      TransitionPayloadError,
    );
  });

  it('REFUSES a file name', () => {
    expect(ok('conversation.first_public_reply', { messageId: 'm-1', filename: 'a.png' })).toThrow(
      TransitionPayloadError,
    );
  });

  it('REFUSES the SUBJECT TEXT — the sharpest case and the easiest to miss', () => {
    // The subject is the CUSTOMER's own words. `conversation.subject_set` is precisely the type
    // tempted to carry it, and doing so would put customer text into an append-only store
    // (Principle IV / FR-007 / SEC-26). The type records THAT a human named it, never WHAT they wrote.
    expect(ok('conversation.status_changed', { from: 'a', to: 'b', subject: 'my deposit' })).toThrow(
      TransitionPayloadError,
    );
    expect(ok('conversation.status_changed', { from: 'a', to: 'b', title: 'my deposit' })).toThrow(
      TransitionPayloadError,
    );
    expect(ok('conversation.status_changed', { from: 'a', to: 'b', text: 'my deposit' })).toThrow(
      TransitionPayloadError,
    );

    // …and on the type that actually exists for it (T028a). `source` is the WHOLE payload.
    expect(ok('conversation.subject_set', { source: 'manual' })).not.toThrow();
    expect(ok('conversation.subject_set', { source: 'auto' })).not.toThrow();
    for (const smuggled of ['subject', 'title', 'text', 'body', 'value']) {
      expect(ok('conversation.subject_set', { source: 'manual', [smuggled]: 'my deposit' })).toThrow(
        TransitionPayloadError,
      );
    }
  });

  it('refuses a value that is not an id or an enum — length is bounded', () => {
    // Even an allow-listed key must not become a smuggling channel for a paragraph.
    expect(ok('conversation.status_changed', { from: 'open', to: 'x'.repeat(500) })).toThrow(
      TransitionPayloadError,
    );
  });

  it('refuses a nested object — flat ids and enums only', () => {
    expect(ok('conversation.assigned', { to: { id: 'op-1' } })).toThrow(TransitionPayloadError);
  });

  it('refuses a payload for an unknown type', () => {
    expect(ok('conversation.nope', {})).toThrow(TransitionPayloadError);
  });

  it('accepts an empty payload where the type declares none', () => {
    // A type may legitimately carry nothing: the fact and its dimensions are the record.
    expect(ok('conversation.status_changed', undefined)).toThrow(TransitionPayloadError);
  });
});
