import { GatewayDataAccess } from './gateway-data-access';
import { fixturePort, loadFixture, fixtureNames, type RecordedResponse } from './fixture-port';
import { MAX_PAGE_SIZE } from '../types';
import type { DataError } from '../types';

/**
 * T009–T013 [US1] — the transport, driven by responses RECORDED off the live gateway.
 *
 * Every fixture here was produced by `specs/019-gateway-transport/track-b.sh` against `beton-test`.
 * None was written by hand; see `fixture-port.ts` for why that distinction is the point.
 */

const LIST = loadFixture('conversations-list-admin');
const GET = loadFixture('conversation-get-admin');
const MISSING = loadFixture('conversation-get-missing');

function daFor(responses: RecordedResponse[]) {
  const fp = fixturePort(responses);
  return { da: new GatewayDataAccess(fp.port), calls: fp.calls };
}

describe('the recorded corpus exists', () => {
  it('there are fixtures to replay (an empty corpus would make every test below vacuous)', () => {
    expect(fixtureNames().length).toBeGreaterThan(5);
  });

  it('the list fixture is a real gateway 200, not an error body', () => {
    // 018 had two assertions pass by comparing two identical ERROR payloads. Establish the subject.
    expect(LIST.status).toBe(200);
    expect(Array.isArray((LIST.body as Record<string, unknown>).conversations)).toBe(true);
  });
});

describe('T009 — envelope translation', () => {
  it("items come from the row's collection key, not a uniform 'items'", async () => {
    const { da } = daFor([LIST]);
    const page = await da.list('conversations', { limit: 2 });
    const recorded = (LIST.body as { conversations: unknown[] }).conversations;
    expect(page.items).toEqual(recorded);
  });

  it('an empty continuation token becomes NO cursor — an empty string is not a cursor', async () => {
    const { da } = daFor([{ ...LIST, body: { conversations: [], nextPageToken: '' } }]);
    const page = await da.list('conversations', { limit: 2 });
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it('hasMore is derived from the cursor, never from the item count', async () => {
    // A FULL page is not evidence of a next one, and an EMPTY page with a token is legal. Deriving
    // from length gets both wrong, and the second one loops forever.
    const full = { ...LIST, body: { conversations: [{ id: 'a' }, { id: 'b' }], nextPageToken: '' } };
    const emptyWithToken = { ...LIST, body: { conversations: [], nextPageToken: 'tok' } };

    const a = await daFor([full]).da.list('conversations', { limit: 2 });
    expect(a.items).toHaveLength(2);
    expect(a.hasMore).toBe(false);

    const b = await daFor([emptyWithToken]).da.list('conversations', { limit: 2 });
    expect(b.items).toHaveLength(0);
    expect(b.hasMore).toBe(true);
    expect(b.nextCursor).toBe('tok');
  });

  it('a missing collection array is an empty page, not a crash', async () => {
    const { da } = daFor([{ ...LIST, body: { nextPageToken: '' } }]);
    await expect(da.list('conversations', { limit: 2 })).resolves.toMatchObject({ items: [] });
  });
});

describe('T010 — paging', () => {
  it('the cursor is sent as the route’s own page-token parameter', async () => {
    const { da, calls } = daFor([LIST]);
    await da.list('conversations', { limit: 2, cursor: 'TOKEN-1' });
    expect(calls[0]!.query).toMatchObject({ pageToken: 'TOKEN-1', pageSize: '2' });
  });

  it('no cursor on the first page — an empty token must not be sent as one', async () => {
    const { da, calls } = daFor([LIST]);
    await da.list('conversations', { limit: 2, cursor: null });
    expect(calls[0]!.query).not.toHaveProperty('pageToken');
  });
});

describe('T011 — a record, and one that is not there', () => {
  it('an existing id returns the record', async () => {
    const { da } = daFor([GET]);
    await expect(da.get('conversations', 'x')).resolves.toEqual(GET.body);
  });

  it('an unknown id rejects as non-retryable', async () => {
    expect(MISSING.status).toBe(404); // the recording really is a 404
    const { da } = daFor([MISSING]);
    await expect(da.get('conversations', 'nope')).rejects.toMatchObject({ retryable: false });
  });

  it('the rejection carries no identifier, no path and no server text', async () => {
    const { da } = daFor([MISSING]);
    const err = await da.get('conversations', 'seed-player-001').catch((e: DataError) => e);
    const text = JSON.stringify(err);
    expect(text).not.toContain('seed-player-001');
    expect(text).not.toContain('/conversations');
    expect(text).not.toContain('api');
  });
});

describe('T012 — the page-size ceiling is refused, not silently reduced', () => {
  it(`a limit above ${MAX_PAGE_SIZE} is refused and nothing is sent`, async () => {
    const { da, calls } = daFor([LIST]);
    await expect(da.list('conversations', { limit: MAX_PAGE_SIZE + 1 })).rejects.toMatchObject({
      retryable: false,
    });
    // Silently clamping teaches a caller the parameter is advisory; the next thing it sends is worse.
    expect(calls).toHaveLength(0);
  });

  it('the ceiling itself is accepted', async () => {
    const { da } = daFor([LIST]);
    await expect(da.list('conversations', { limit: MAX_PAGE_SIZE })).resolves.toBeDefined();
  });
});

describe('T013 — *** an undeclared parameter never leaves the browser ***', () => {
  it('a filter the row does not declare is refused BEFORE any request is made', async () => {
    const { da, calls } = daFor([LIST]);
    await expect(
      da.list('conversations', { limit: 2, filters: { nope: 'x' } }),
    ).rejects.toMatchObject({ retryable: false });

    // The whole point of FR-004. `/conversations` would have answered 200 and SILENTLY DROPPED the
    // filter — a confident wrong answer, and the widening direction. Recorded live as E6.
    expect(calls).toHaveLength(0);
  });

  it('the refusal names the parameter and never its value (a value can be a customer id)', async () => {
    const { da } = daFor([LIST]);
    const err = await da
      .list('conversations', { limit: 2, filters: { nope: 'ply-4711@example.com' } })
      .catch((e: DataError) => e);
    expect((err as DataError).message).toContain('nope');
    expect((err as DataError).message).not.toContain('ply-4711');
  });

  it('a declared filter IS sent, under its wire name', async () => {
    const { da, calls } = daFor([LIST]);
    await da.list('conversations', { limit: 2, filters: { status: 'open' } });
    expect(calls[0]!.query).toMatchObject({ status: 'open' });
  });

  it('a sort is refused — no route accepts one, and an unsorted list would be a silent lie', async () => {
    const { da, calls } = daFor([LIST]);
    await expect(
      da.list('conversations', { limit: 2, sort: [{ field: 'createdAt', dir: 'desc' }] }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });
});
