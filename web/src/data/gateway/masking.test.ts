import { GatewayDataAccess } from './gateway-data-access';
import { fixturePort, loadFixture, type RecordedResponse } from './fixture-port';
import type { DataError } from '../types';

/**
 * T017–T020 [US2] — the masking guarantee, checked at the client end of the wire.
 *
 * Every fixture here was RECORDED from the live gateway as two real roles
 * (`specs/019-gateway-transport/track-b.sh`). That matters more here than anywhere else in this
 * feature: this pair of recordings is what falsified the claim — made in two shipped documents — that
 * withheld fields were already absent from the response. They were blanked. The server was fixed the
 * same day; these tests are the offline half of that proof, and they are written so that a regression
 * in EITHER direction fails.
 */

const ADMIN = loadFixture('player-get-admin');
const SUPPORT = loadFixture('player-get-support');
const LIST_REFUSED = loadFixture('players-list-support');
const LIST_OK = loadFixture('players-list-admin');

const BRAND = 'seed-brand-0000-0000-000000000001';

function daFor(responses: RecordedResponse[]) {
  const fp = fixturePort(responses);
  return { da: new GatewayDataAccess(fp.port), calls: fp.calls };
}

const keysOf = (o: unknown) => Object.keys(o as Record<string, unknown>).sort();

describe('the recordings are real, and they are of two different roles', () => {
  it('both reads succeeded — a comparison of two error bodies proves nothing', () => {
    // 018 shipped two assertions that passed by comparing two identical error payloads. Establish
    // the subjects before comparing them.
    expect(ADMIN.status).toBe(200);
    expect(SUPPORT.status).toBe(200);
    expect((ADMIN.body as Record<string, unknown>).playerId).toBe(
      (SUPPORT.body as Record<string, unknown>).playerId,
    );
  });
});

describe('*** T017: a withheld field is ABSENT from what the caller receives ***', () => {
  it('the uncleared role receives fewer keys than the cleared one', async () => {
    const { da } = daFor([SUPPORT]);
    const record = await da.get('players', 'seed-player-001');
    expect(keysOf(record).length).toBeLessThan(keysOf(ADMIN.body).length);
  });

  it('every key the cleared role has and the uncleared lacks is genuinely gone, not blanked', async () => {
    const { da } = daFor([SUPPORT]);
    const record = (await da.get('players', 'seed-player-001')) as Record<string, unknown>;

    const withheld = keysOf(ADMIN.body).filter((k) => !keysOf(SUPPORT.body).includes(k));
    // Guard: if the seed ever stops populating a maskable field, this test would silently verify
    // nothing at all.
    expect(withheld.length).toBeGreaterThan(0);

    for (const key of withheld) {
      // `hasOwnProperty`, not falsiness — blank and absent are exactly what 011's FR-014 separates.
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
    }
  });

  it('the transport invents nothing: the record is passed through unchanged', async () => {
    const { da } = daFor([SUPPORT]);
    // No defaulting, no normalising, no fixed shape. Re-adding a key client-side would undo, one
    // layer up, precisely the repair the server just received.
    await expect(da.get('players', 'seed-player-001')).resolves.toEqual(SUPPORT.body);
  });

  it('no withheld value appears anywhere in the uncleared response', async () => {
    const { da } = daFor([SUPPORT]);
    const record = await da.get('players', 'seed-player-001');
    const admin = ADMIN.body as Record<string, unknown>;
    const withheld = keysOf(admin).filter((k) => !keysOf(SUPPORT.body).includes(k));

    const text = JSON.stringify(record);
    for (const key of withheld) {
      const value = admin[key];
      // Not just absent under its own name — the value must not have been smuggled into another one.
      if (typeof value === 'string' && value.length > 0) expect(text).not.toContain(value);
    }
  });
});

describe('*** T018: the cleared role HAS what the other lacks (so absence means something) ***', () => {
  it('the cleared role receives the withheld keys, populated', async () => {
    const { da } = daFor([ADMIN]);
    const record = (await da.get('players', 'seed-player-001')) as Record<string, unknown>;
    const withheld = keysOf(ADMIN.body).filter((k) => !keysOf(SUPPORT.body).includes(k));

    for (const key of withheld) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(true);
      expect(record[key]).not.toBe('');
    }
  });

  it('nothing is PARTIALLY disclosed — the lower role gets the field whole or not at all', async () => {
    const support = SUPPORT.body as Record<string, unknown>;
    const admin = ADMIN.body as Record<string, unknown>;
    for (const key of keysOf(support)) {
      // A truncated or redacted-looking value would be a third state, and worse than either: it
      // discloses that something exists AND is unusable.
      expect(support[key]).toEqual(admin[key]);
    }
  });
});

describe('*** T019: a refusal is not an empty page ***', () => {
  it('the tier refusal rejects, and does not resolve with zero rows', async () => {
    expect(LIST_REFUSED.status).toBe(403); // the recording really is a refusal
    const { da } = daFor([LIST_REFUSED]);
    await expect(
      da.list('players', { limit: 10, filters: { brandId: BRAND } }),
    ).rejects.toMatchObject({ code: 'refused', retryable: false });
  });

  it('…while an allowed-but-empty list RESOLVES with no items', async () => {
    const empty = { ...LIST_OK, body: { players: [], nextPageToken: '' } };
    const { da } = daFor([empty]);
    await expect(da.list('players', { limit: 10, filters: { brandId: BRAND } })).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('the refusal reveals nothing about why', async () => {
    const { da } = daFor([LIST_REFUSED]);
    const err = (await da
      .list('players', { limit: 10, filters: { brandId: BRAND } })
      .catch((e: DataError) => e)) as DataError;
    // 403 covers a missing permission AND a tier refusal, deliberately indistinguishable.
    expect(JSON.stringify(err)).not.toContain('tier');
    expect(JSON.stringify(err)).not.toContain(BRAND);
  });
});

describe('*** T020: the required brand is enforced before anything is sent ***', () => {
  it('listing customers without a brand is refused client-side, naming the parameter', async () => {
    const { da, calls } = daFor([LIST_OK]);
    const err = (await da.list('players', { limit: 10 }).catch((e: DataError) => e)) as DataError;

    expect(err.retryable).toBe(false);
    expect(err.message).toContain('brandId');
    // The point of doing it here: a missing brand server-side would mean "every customer in the
    // account". The request must not exist at all.
    expect(calls).toHaveLength(0);
  });

  it('an empty brand counts as missing, not as a filter matching nothing', async () => {
    const { da, calls } = daFor([LIST_OK]);
    await expect(da.list('players', { limit: 10, filters: { brandId: '' } })).rejects.toMatchObject({
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('with a brand, the request goes out carrying it', async () => {
    const { da, calls } = daFor([LIST_OK]);
    await da.list('players', { limit: 10, filters: { brandId: BRAND } });
    expect(calls[0]!.query).toMatchObject({ brandId: BRAND, pageSize: '10' });
  });
});
