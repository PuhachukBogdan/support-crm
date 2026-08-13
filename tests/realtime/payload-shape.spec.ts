import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  REALTIME_EVENT_KINDS,
  REALTIME_PAYLOAD_KEYS,
  parseRealtimeEvent,
  realtimeChannel,
} from '../../libs/common/src';

/**
 * T003 (feature 034, W4 — FR-002) — **the realtime payload is the security boundary, so its SHAPE is
 * asserted rather than trusted.**
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * The whole design of this block is that a socket carries **no content**: an event says *what changed*,
 * the client re-reads through REST, and every read rule stays in one place — above all the customer
 * projection that filters private notes AT THE QUERY (feature 012, SEC-13).
 *
 * That property has exactly one failure mode, and it is not an attack: somebody adds a field because it
 * saves a round-trip. `subject` is the obvious first one, and it is a customer's words; `fromAddress` is
 * the second, and it is the value W3 spent a whole feature keeping out of `chats_db`. This test is what
 * makes that a failing build rather than a leak nobody notices for three days.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const ROOT = resolve(__dirname, '..', '..');
const SOURCE = readFileSync(
  join(ROOT, 'libs', 'common', 'src', 'realtime', 'events.ts'),
  'utf8',
);

/** Comments stripped: the header above NAMES the forbidden fields, and must not read as declaring them. */
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the realtime payload carries identifiers and nothing else (FR-001/FR-002)', () => {
  it('declares exactly four keys', () => {
    expect([...REALTIME_PAYLOAD_KEYS]).toEqual(['kind', 'accountId', 'conversationId', 'messageId']);
  });

  /**
   * The interface is read as text on purpose. A type test would pass on a shape widened with
   * `[key: string]: unknown`, which is the widening most likely to be added "temporarily".
   */
  it('the interface declares no field beyond them, and no index signature', () => {
    const body = /export interface RealtimeEvent \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    expect(body).not.toBe('');
    const declared = [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...REALTIME_PAYLOAD_KEYS].sort());
    expect(body).not.toMatch(/\[\s*key\s*:/);
    expect(body).not.toMatch(/Record<string/);
  });

  it.each(['subject', 'body', 'bodyText', 'authorName', 'fromAddress', 'address', 'text', 'preview'])(
    'the payload type does not declare `%s` — a customer\'s words never ride the socket',
    (forbidden) => {
      const body = /export interface RealtimeEvent \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
      expect(body).not.toMatch(new RegExp(`\\b${forbidden}\\b\\??:`, 'i'));
    },
  );

  /** The detector must be able to fail, or this suite is decorative. */
  it('the detector catches a planted field (this guard is not vacuous)', () => {
    const planted = 'export interface RealtimeEvent {\n  readonly subject: string;\n}';
    const body = /export interface RealtimeEvent \{([\s\S]*?)\n\}/.exec(planted)?.[1] ?? '';
    expect(body).toMatch(/\bsubject\b\??:/);
  });
});

describe('the parser re-asserts the boundary on the way OUT (defence in depth)', () => {
  /**
   * The gateway forwards what the parser returns. So a publisher that someday adds a field cannot have it
   * reach a browser even if the type is widened first: unknown keys are **dropped**, not passed through.
   */
  it('drops any field it does not know, including a subject and an address', () => {
    const raw = JSON.stringify({
      kind: 'message.created',
      accountId: 'acc-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      subject: 'Не приходит вывод',
      fromAddress: 'player@mail.test',
      bodyText: 'третий день не приходит вывод',
    });
    const event = parseRealtimeEvent(raw);
    expect(event).toEqual({
      kind: 'message.created',
      accountId: 'acc-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
    expect(JSON.stringify(event)).not.toContain('вывод');
    expect(JSON.stringify(event)).not.toContain('player@mail.test');
  });

  it('refuses an unrecognised kind rather than forwarding it', () => {
    const raw = JSON.stringify({ kind: 'note.created', accountId: 'a', conversationId: 'c' });
    expect(parseRealtimeEvent(raw)).toBeNull();
  });

  it.each([
    ['not json at all', 'not json'],
    ['a missing account', JSON.stringify({ kind: 'conversation.created', conversationId: 'c' })],
    ['an empty account', JSON.stringify({ kind: 'conversation.created', accountId: '', conversationId: 'c' })],
    ['a missing conversation', JSON.stringify({ kind: 'conversation.created', accountId: 'a' })],
  ])('returns null for %s', (_name, raw) => {
    expect(parseRealtimeEvent(raw)).toBeNull();
  });

  it('keeps messageId absent rather than empty on a conversation event', () => {
    const raw = JSON.stringify({ kind: 'conversation.created', accountId: 'a', conversationId: 'c' });
    expect(parseRealtimeEvent(raw)).toEqual({
      kind: 'conversation.created',
      accountId: 'a',
      conversationId: 'c',
    });
  });
});

describe('there is no tenant-less channel to publish to (FR-010)', () => {
  it('builds a per-account channel name', () => {
    expect(realtimeChannel('acc-1')).toBe('crm:rt:acct:acc-1');
  });

  /**
   * ⭐ Fail CLOSED, and loudly. An empty account would produce one shared channel name that every socket
   * in every tenant could plausibly be joined to — the worst outcome a silent default could have here,
   * and the exact shape of the `''`-keyed profile the operator-profile service refuses for the same
   * reason.
   */
  it.each(['', '   '])('refuses an empty account (%p) instead of defaulting', (bad) => {
    expect(() => realtimeChannel(bad)).toThrow(/requires an account/);
  });

  it('exposes no builder that omits the account', () => {
    expect(code).not.toMatch(/realtimeBroadcastChannel|globalChannel|allAccounts/i);
    // …and the one builder takes a required parameter, not an optional one.
    expect(code).toMatch(/export function realtimeChannel\(accountId: string\)/);
  });
});

describe('the kind catalogue is closed', () => {
  it('holds exactly the three kinds this block ships', () => {
    expect([...REALTIME_EVENT_KINDS]).toEqual([
      'conversation.created',
      'conversation.updated',
      'message.created',
    ]);
  });
});
