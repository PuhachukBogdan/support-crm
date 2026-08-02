import { OutboxEmailAdapter, type OutboundLoginCode } from './email.port';

/**
 * T008 (feature 009) — the dev EmailPort delivers a code to an inspectable outbox and NEVER
 * logs it (Principle IV). FAILS before the port exists.
 */
/**
 * ⚠️ Feature 028 removed the two dev-sink tests with the sink itself: a live one-time code in a
 * plaintext file was the weaker of two ways to obtain one, and real SMTP now exists. What remains
 * is the in-memory double the unit specs use.
 */
describe('OutboxEmailAdapter (test double)', () => {
  const msg: OutboundLoginCode = {
    to: 'agent@example.test',
    code: '4F9K2Q',
    challengeId: 'chal-1',
    purpose: 'login_2fa',
    expiresAt: new Date('2026-07-21T00:10:00.000Z'),
    accountId: 'acc-1', // feature 028 — the outbox row is tenant-owned data (Principle I)
  };

  it('records the delivered code in the outbox for inspection', async () => {
    const email = new OutboxEmailAdapter();
    await email.sendLoginCode(msg);
    expect(email.outbox).toHaveLength(1);
    expect(email.last()).toEqual(msg);
    expect(email.for('agent@example.test')).toHaveLength(1);
  });

  it('never writes the code to logs (no console output)', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const email = new OutboxEmailAdapter();
      await email.sendLoginCode(msg);
      const logged = spy.mock.calls.flat().map(String).join('\n');
      expect(logged).not.toContain(msg.code);
    } finally {
      spy.mockRestore();
    }
  });

  it('snapshots the message so later caller mutation cannot rewrite history', async () => {
    const email = new OutboxEmailAdapter();
    const mutable = { ...msg };
    await email.sendLoginCode(mutable);
    mutable.code = 'CHANGED';
    expect(email.last()!.code).toBe('4F9K2Q');
  });


});
