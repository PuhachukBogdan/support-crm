import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayDataAccess } from './gateway-data-access';
import { fixturePort } from './fixture-port';
import type { DataError } from '../types';
import { classifyStatus, type FailureClass } from '../errors';

/**
 * T031 [Polish] — FR-009 / conformance C-6 / SEC-26: nothing about the request or the response may
 * reach a surfaced error.
 *
 * Checked over EVERY failure class rather than on one example, because the guarantee is a property of
 * the mapping and not of a particular path. A server that starts echoing a filter value, or a proxy
 * that returns an HTML error page, must change nothing about what a caller sees.
 */

const SECRETS = {
  playerId: 'seed-player-001',
  email: 'ply-4711@example.com',
  phone: '+34600111222',
  token: 'eyJhbGciOiJIUzI1NiJ9.SECRET.sig',
  brand: 'seed-brand-0000-0000-000000000001',
};

/** A body of the shape a careless server might send: everything sensitive, all at once. */
const CHATTY_BODY = {
  message: `filter playerId=${SECRETS.playerId} rejected for ${SECRETS.email}`,
  detail: { phone: SECRETS.phone, token: SECRETS.token, brandId: SECRETS.brand },
  stack: 'at PlayersController.listPlayers (/app/services/gateway/src/players/…)',
};

const STATUSES: [number, FailureClass][] = [
  [400, 'invalid-request'],
  [401, 'no-session'],
  [403, 'refused'],
  [404, 'not-found'],
  [500, 'unavailable'],
  [0, 'unavailable'],
];

function assertClean(err: unknown): void {
  const text = JSON.stringify(err);
  for (const [label, value] of Object.entries(SECRETS)) {
    expect(`${label}:${text}`).not.toContain(value);
  }
  expect(text).not.toContain('/players');
  expect(text).not.toContain('/conversations');
  expect(text).not.toContain('/api');
  expect(text).not.toContain('stack');
  expect(text).not.toContain('PlayersController');
}

describe('*** no failure class leaks the request or the response ***', () => {
  it.each(STATUSES)('status %i is classified as %s and says nothing else', async (status, cls) => {
    const { da } = {
      da: new GatewayDataAccess(fixturePort([{ status, path: '/players', body: CHATTY_BODY }]).port),
    };
    const err = (await da
      .list('players', { limit: 10, filters: { brandId: SECRETS.brand } })
      .catch((e: DataError) => e)) as DataError;

    expect(err.code).toBe(cls);
    expect(classifyStatus(status)).toBe(cls);
    assertClean(err);
  });

  it('a body that is not JSON becomes a class, and its content is never carried', async () => {
    // The realistic case: a proxy or ingress in front of the gateway returning an HTML error page.
    const port = fixturePort([
      { status: 502, path: '/conversations', body: undefined, unparseable: true },
    ]).port;
    const err = (await new GatewayDataAccess(port)
      .list('conversations', { limit: 5 })
      .catch((e: DataError) => e)) as DataError;

    expect(err.retryable).toBe(true);
    assertClean(err);
    expect(JSON.stringify(err)).not.toContain('html');
  });

  it('a client-side refusal names the KEY and never the value', async () => {
    const err = (await new GatewayDataAccess(fixturePort([]).port)
      .list('players', { limit: 10, filters: { brandId: SECRETS.brand, nope: SECRETS.email } })
      .catch((e: DataError) => e)) as DataError;

    expect(err.message).toContain('nope');
    expect(err.message).not.toContain(SECRETS.email);
  });

  it('a record identifier never survives into a not-found error', async () => {
    const err = (await new GatewayDataAccess(
      fixturePort([{ status: 404, path: '/players', body: CHATTY_BODY }]).port,
    )
      .get('players', SECRETS.playerId)
      .catch((e: DataError) => e)) as DataError;

    assertClean(err);
  });
});

describe('the transport writes no log line of its own', () => {
  it('there is no logger and no console call anywhere in the transport', () => {
    // The strongest available form, and it costs nothing here: this layer has nothing to say that
    // the caller's own error handling does not already receive. Same stance as the exports edge.
    const files = ['gateway-data-access.ts', 'http-port.ts', 'registry.ts'];
    for (const f of files) {
      const code = readFileSync(join(__dirname, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\b/);
      expect(code).not.toMatch(/\bnew Logger\b/);
    }
  });
});
