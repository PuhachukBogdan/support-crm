import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxEmailAdapter, type OutboundLoginCode } from './email.port';

/**
 * T008 (feature 009) — the dev EmailPort delivers a code to an inspectable outbox and NEVER
 * logs it (Principle IV). FAILS before the port exists.
 */
describe('OutboxEmailAdapter (dev EmailPort)', () => {
  const msg: OutboundLoginCode = {
    to: 'agent@example.test',
    code: '4F9K2Q',
    challengeId: 'chal-1',
    purpose: 'login_2fa',
    expiresAt: new Date('2026-07-21T00:10:00.000Z'),
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

  it('does NOT touch any file when no dev sink path is configured', async () => {
    // Default (no path / env unset) — production & tests must not write a code to disk.
    const email = new OutboxEmailAdapter(undefined);
    await email.sendLoginCode(msg); // must not throw despite no sink
    expect(email.outbox).toHaveLength(1);
  });

  it('appends the code as one JSON line to an explicit dev sink file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crm-outbox-'));
    const sink = join(dir, 'codes.log');
    try {
      const email = new OutboxEmailAdapter(sink);
      await email.sendLoginCode(msg);
      await email.sendLoginCode({ ...msg, challengeId: 'chal-2', code: 'ZZZ999' });

      expect(existsSync(sink)).toBe(true);
      const lines = readFileSync(sink, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as Record<string, string>;
      expect(first).toMatchObject({ to: msg.to, code: msg.code, challengeId: 'chal-1' });
      expect(first.expiresAt).toBe(msg.expiresAt.toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
