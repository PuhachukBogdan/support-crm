import { CHATS_SECURITY_FACTS, type ChatsFactContext } from './facts.registry';
import { resolveFacts } from './facts.service';

/**
 * ⭐ W32 / 039 — the chats registry, behaviourally. The structural half (every `read` really reads)
 * is `tests/security-posture/facts-are-read.spec.ts`; this is about what the page ends up saying.
 */

const ctxWith = (db: unknown): ChatsFactContext => ({ db }) as ChatsFactContext;

const fakeDb = (enabled: number, total: number, restricted: number, fail = false) => ({
  channel: {
    count: jest.fn((args?: { where?: { enabled?: boolean } }) =>
      fail ? Promise.reject(new Error('db down')) : Promise.resolve(args?.where ? enabled : total),
    ),
  },
  fieldDefinition: { count: jest.fn().mockResolvedValue(restricted) },
});

describe('chats security facts (W32 / 039)', () => {
  it('reads channels and restricted fields, and a channel that is off asks for attention', async () => {
    const facts = await resolveFacts(CHATS_SECURITY_FACTS, ctxWith(fakeDb(2, 3, 1)));
    expect(facts.find((f) => f.key === 'chats.channels.enabled')).toMatchObject({
      kind: 'read',
      state: 'attention',
      value: 'включено 2 из 3',
    });
    expect(facts.find((f) => f.key === 'chats.fields.restricted')).toMatchObject({
      kind: 'read',
      state: 'ok',
      value: '1',
    });
  });

  it('every channel on ⇒ ok; and a read that fails is `unknown`, still shown, never `ok`', async () => {
    const healthy = await resolveFacts(CHATS_SECURITY_FACTS, ctxWith(fakeDb(3, 3, 0)));
    expect(healthy.find((f) => f.key === 'chats.channels.enabled')?.state).toBe('ok');

    const broken = await resolveFacts(CHATS_SECURITY_FACTS, ctxWith(fakeDb(0, 0, 0, true)));
    expect(broken.find((f) => f.key === 'chats.channels.enabled')?.state).toBe('unknown');
  });

  it('the built-in fact renders from its constant and carries no reader', () => {
    const builtIn = CHATS_SECURITY_FACTS.filter((f) => f.kind === 'built_in');
    expect(builtIn.length).toBeGreaterThan(0);
    for (const entry of builtIn) {
      expect(entry.read).toBeUndefined();
      expect(entry.value).toBeTruthy();
    }
  });
});
