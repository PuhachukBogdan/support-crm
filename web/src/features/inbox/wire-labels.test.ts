import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relativeTime, statusFromWire } from './wire-labels';
import { makeConversationRows } from './test-support';

/**
 * The translation that was missing, and the guard that keeps the stub honest about it.
 *
 * ⭐ **Found in a real browser, on real data, with the entire suite green.** The Status column read
 * `conversation_status_open`, because the gateway sends `CONVERSATION_STATUS_OPEN` and the stub had
 * invented `open`. A fixture that is friendlier than the server hides exactly the defects a fixture
 * exists to expose.
 */
describe('statusFromWire', () => {
  it('⭐ turns the wire enum into the word a person reads', () => {
    expect(statusFromWire('CONVERSATION_STATUS_OPEN')).toBe('open');
    expect(statusFromWire('CONVERSATION_STATUS_PENDING')).toBe('pending');
    expect(statusFromWire('CONVERSATION_STATUS_RESOLVED')).toBe('resolved');
    expect(statusFromWire('CONVERSATION_STATUS_SNOOZED')).toBe('snoozed');
  });

  it('renders UNSPECIFIED and empty as nothing — "not set", never a status called unspecified', () => {
    expect(statusFromWire('CONVERSATION_STATUS_UNSPECIFIED')).toBe('');
    expect(statusFromWire('')).toBe('');
  });

  it('never leaks the raw prefix — the actual defect, stated as an assertion', () => {
    for (const wire of [
      'CONVERSATION_STATUS_OPEN',
      'CONVERSATION_STATUS_PENDING',
      'CONVERSATION_STATUS_RESOLVED',
    ]) {
      expect(statusFromWire(wire)).not.toContain('conversation_status');
    }
  });

  it('passes an already-plain value through, so a future plain-status API is not mangled', () => {
    expect(statusFromWire('open')).toBe('open');
  });
});

/**
 * ⭐ Relative time, copied from Zendesk (`screenshots/views_2.png` — "13 minutes ago").
 *
 * A queue is scanned for how long something has waited; an absolute timestamp makes the reader do
 * that subtraction once per row. Ours showed `8/2/2026, 7:37:08 PM`.
 */
describe('relativeTime', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('⭐ reads like Zendesk', () => {
    expect(relativeTime(ago(13 * MIN), now)).toBe('13 minutes ago');
    expect(relativeTime(ago(1 * MIN), now)).toBe('1 minute ago');
    expect(relativeTime(ago(3 * HOUR), now)).toBe('3 hours ago');
    expect(relativeTime(ago(1 * DAY), now)).toBe('1 day ago');
  });

  it('says "just now" rather than a number for the last few seconds', () => {
    expect(relativeTime(ago(5000), now)).toBe('just now');
  });

  it('⚠️ a clock skew never produces a time in the future', () => {
    // Browser and server clocks differ; "in 3 seconds" on a support queue reads as a bug.
    expect(relativeTime(new Date(now.getTime() + 30_000).toISOString(), now)).toBe('just now');
  });

  it('falls back to a date once "N weeks ago" stops being useful', () => {
    const old = relativeTime(ago(40 * DAY), now);
    expect(old).not.toMatch(/ago/);
    expect(old).toMatch(/\d/);
  });

  it('renders nothing for an absent or unparseable value', () => {
    expect(relativeTime('', now)).toBe('');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('*** the stub speaks the SERVER’s vocabulary, not a friendlier one ***', () => {
  it('⭐ the stub’s status is the wire enum, matching the recorded fixture', () => {
    const [row] = makeConversationRows(1);
    expect(row!.status).toMatch(/^CONVERSATION_STATUS_/);
  });

  it('…and the recorded gateway fixture agrees — this is the shape the server really sends', () => {
    // The fixture was recorded off the live gateway; if these two ever disagree, the stub is lying.
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'data', 'gateway', 'fixtures', 'conversations-page1.json'),
        'utf8',
      ),
    ) as { body: { conversations: { status: string }[] } };
    const recorded = fixture.body.conversations[0]!.status;
    expect(recorded).toMatch(/^CONVERSATION_STATUS_/);
    expect(statusFromWire(recorded)).not.toContain('conversation_status');
  });
});
