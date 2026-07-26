import { Metadata } from '@grpc/grpc-js';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { decodeComposite, encodeComposite } from '@crm/common';
import { AuditFederation, AuditSourceError } from './audit.federation';

/**
 * T023 (feature 015, US1) — the federated read. FAILS before it exists, PASSES after.
 *
 * The assertion that matters most is the failure mode: **a source that cannot be read is an ERROR, not a
 * short page.** An administrator investigating "did anyone touch this player's data?" and seeing an empty
 * result must not be looking at a page that silently omitted a third of the trail. "No entries" and "one
 * source was unreachable" have to be distinguishable, or the log's answers cannot be relied on — which is
 * the entire point of building it.
 */
const entry = (id: string, createdAt: string) => ({
  id,
  createdAt,
  source: '',
  actorUserId: 'god',
  actorKind: 'ACTOR_KIND_USER',
  actorRef: '',
  underPreview: false,
  action: 'permission.grant',
  targetRef: 'u-1',
  detailJson: '',
});

function build(
  pages: Record<string, { entries: ReturnType<typeof entry>[]; nextPageToken: string } | 'error'>,
) {
  const calls: Record<string, jest.Mock> = {};
  const client = (name: string) =>
    ({
      getService: () => {
        const page = pages[name]!;
        const fn = jest.fn(() =>
          page === 'error'
            ? throwError(() => Object.assign(new Error('unavailable'), { code: 14 }))
            : of(page),
        );
        calls[name] = fn;
        return { listAuditEntries: fn };
      },
    }) as unknown as ClientGrpc;

  const fed = new AuditFederation(client('auth'), client('users'), client('chats'));
  fed.onModuleInit();
  return { fed, calls };
}

const query = (over: Partial<Parameters<AuditFederation['list']>[0]> = {}) => ({
  pageSize: 10,
  ...over,
});

describe('fan-out and merge', () => {
  it('interleaves three sources into one newest-first page', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: { entries: [entry('u1', '2026-07-27T13:00:00Z')], nextPageToken: '' },
      chats: { entries: [entry('c1', '2026-07-27T11:00:00Z')], nextPageToken: '' },
    });
    const page = await fed.list(query(), new Metadata());
    expect(page.entries.map((e) => e.id)).toEqual(['u1', 'a1', 'c1']);
  });

  it('stamps each entry with the source that produced it', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    const page = await fed.list(query(), new Metadata());
    expect(page.entries[0]!.source).toBe('auth');
  });

  it('forwards every filter to every source', async () => {
    const { fed, calls } = build({
      auth: { entries: [], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    await fed.list(
      query({ actorUserId: 'god', action: 'role.assign', targetRef: 'u-1', from: '2026-07-01T00:00:00Z' }),
      new Metadata(),
    );
    for (const source of ['auth', 'users', 'chats']) {
      expect(calls[source]!.mock.calls[0]![0]).toMatchObject({
        actorUserId: 'god',
        action: 'role.assign',
        targetRef: 'u-1',
        from: '2026-07-01T00:00:00Z',
      });
    }
  });

  it('propagates the actor metadata so each source can gate independently', async () => {
    const { fed, calls } = build({
      auth: { entries: [], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    const md = new Metadata();
    md.set('x-actor-account-id', 'acc-1');
    await fed.list(query(), md);
    expect((calls.auth!.mock.calls[0]![1] as Metadata).get('x-actor-account-id')[0]).toBe('acc-1');
  });
});

describe('*** a source that cannot be read is an error, not a short page ***', () => {
  it('throws AuditSourceError naming the source', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: 'error',
      chats: { entries: [], nextPageToken: '' },
    });
    const err = await fed.list(query(), new Metadata()).catch((e) => e);
    expect(err).toBeInstanceOf(AuditSourceError);
    expect((err as AuditSourceError).source).toBe('users');
  });

  it('does NOT return the reachable sources as though they were the whole trail', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: 'error',
      chats: { entries: [], nextPageToken: '' },
    });
    await expect(fed.list(query(), new Metadata())).rejects.toBeInstanceOf(AuditSourceError);
  });

  it('lets a client/permission error through unchanged (it is not an availability problem)', async () => {
    const client = (code: number) =>
      ({
        getService: () => ({
          listAuditEntries: jest.fn(() =>
            throwError(() => Object.assign(new Error(String(code)), { code })),
          ),
        }),
      }) as unknown as ClientGrpc;
    const fed = new AuditFederation(client(7), client(7), client(7));
    fed.onModuleInit();
    const err = await fed.list(query(), new Metadata()).catch((e) => e);
    expect(err).not.toBeInstanceOf(AuditSourceError);
    expect((err as { code: number }).code).toBe(7);
  });
});

describe('paging across sources', () => {
  it('sends each source its own position from the composite cursor', async () => {
    const { fed, calls } = build({
      auth: { entries: [], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    const token = encodeComposite({ auth: 'auth-pos', users: 'users-pos', chats: 'chats-pos' });
    await fed.list(query({ pageToken: token }), new Metadata());
    expect(calls.auth!.mock.calls[0]![0].pageToken).toBe('auth-pos');
    expect(calls.chats!.mock.calls[0]![0].pageToken).toBe('chats-pos');
  });

  it('does not re-query a source that the cursor says is exhausted', async () => {
    const { fed, calls } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    // `users` absent from the cursor = exhausted on a previous page. The stub exists (it is created when the
    // service handle is resolved at init), so the assertion is that it was never CALLED.
    await fed.list(query({ pageToken: encodeComposite({ auth: 'p', chats: 'p' }) }), new Metadata());
    expect(calls.users).not.toHaveBeenCalled();
    expect(calls.auth).toHaveBeenCalledTimes(1);
  });

  it('returns a composite token while any source has more', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: 'more' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    const page = await fed.list(query(), new Metadata());
    expect(page.nextPageToken).not.toBe('');
    expect(Object.keys(decodeComposite(page.nextPageToken))).toContain('auth');
  });

  it('returns no token when every source is exhausted', async () => {
    const { fed } = build({
      auth: { entries: [entry('a1', '2026-07-27T12:00:00Z')], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    const page = await fed.list(query(), new Metadata());
    expect(page.nextPageToken).toBe('');
  });

  it('refuses a malformed composite token rather than restarting from the top', async () => {
    const { fed } = build({
      auth: { entries: [], nextPageToken: '' },
      users: { entries: [], nextPageToken: '' },
      chats: { entries: [], nextPageToken: '' },
    });
    await expect(fed.list(query({ pageToken: 'garbage' }), new Metadata())).rejects.toThrow();
  });
});
