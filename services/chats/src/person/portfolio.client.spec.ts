import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import {
  MembershipUnavailableError,
  PersonMembersClient,
  CHATS_PERSON_CLIENT,
} from './person-members.client';

/**
 * T004/T006/T007 — the portfolio read (feature 030, roadmap 4.14).
 *
 * ⚠️ **Every negative assertion here carries its positive control**, because *"the portfolio is empty"* is
 * satisfied by a client that never called anything, a fake that returns nothing, and a method that throws
 * before it starts. At feature 026 the positive control was the only thing between us and shipping a
 * security claim on a lie — and that claim was the same shape as this one.
 */

type ListArgs = { amAuthUserId: string; pageSize: number; pageToken: string };

function clientWith(
  pages: Array<{ assignments?: unknown; nextPageToken?: string }>,
  onCall?: (args: ListArgs, md?: Metadata) => void,
) {
  const calls: Array<{ args: ListArgs; md?: Metadata }> = [];
  let i = 0;
  const users = {
    listAssignedPlayers(args: ListArgs, md?: Metadata) {
      calls.push({ args, md });
      onCall?.(args, md);
      return of(pages[Math.min(i++, pages.length - 1)] ?? {});
    },
  };
  const client = new PersonMembersClient({
    getService: () => users,
    getClientByServiceName: () => users,
  } as never);
  client.onModuleInit();
  return { client, calls };
}

const md = () => {
  const m = new Metadata();
  m.set('x-actor-user-id', 'auth-am-1');
  return m;
};

describe('the caller asks for THEIR OWN portfolio', () => {
  it('⭐ sends an EMPTY subject — the property that makes it self-service with nothing to launder', async () => {
    const { client, calls } = clientWith([
      { assignments: [{ brandId: 'b1', playerId: 'p1' }] },
    ]);

    const out = await client.attachedPlayersOfCaller(md());

    // Positive control: the call happened AND returned the row, so an empty subject below is a fact
    // about the request rather than about a method that did nothing.
    expect(out).toEqual([{ brandId: 'b1', playerId: 'p1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.amAuthUserId).toBe('');
  });

  it("forwards the CALLER's own metadata unchanged, never this service's identity", async () => {
    const mine = md();
    const { client, calls } = clientWith([{ assignments: [] }]);

    await client.attachedPlayersOfCaller(mine);

    expect(calls[0]!.md).toBe(mine);
    expect(calls[0]!.md?.get('x-actor-user-id')).toEqual(['auth-am-1']);
  });
});

describe('a member is (brand, player) — never a bare player id', () => {
  it('⚠️ drops half an identity rather than forwarding it', async () => {
    const { client } = clientWith([
      {
        assignments: [
          { brandId: 'b1', playerId: 'p1' }, // complete
          { playerId: 'p2' }, // no brand — identifies nobody
          { brandId: 'b3' }, // no player
        ],
      },
    ]);

    // Keeping `p2` would select rows by `player_id` alone, and since feature 020 the same id under two
    // brands is routinely two different human beings — another person's conversations in this queue.
    expect(await client.attachedPlayersOfCaller(md())).toEqual([{ brandId: 'b1', playerId: 'p1' }]);
  });
});

describe('the portfolio is EXHAUSTED, never truncated', () => {
  it('follows next_page_token and returns every page', async () => {
    const { client, calls } = clientWith([
      { assignments: [{ brandId: 'b1', playerId: 'p1' }], nextPageToken: 't2' },
      { assignments: [{ brandId: 'b1', playerId: 'p2' }], nextPageToken: '' },
    ]);

    expect(await client.attachedPlayersOfCaller(md())).toEqual([
      { brandId: 'b1', playerId: 'p1' },
      { brandId: 'b1', playerId: 'p2' },
    ]);
    // The second request must carry the token the first returned — otherwise "two pages" is really the
    // first page twice, and the test above would pass on a duplicate.
    expect(calls.map((c) => c.args.pageToken)).toEqual(['', 't2']);
  });

  it('⚠️ REFUSES past the ceiling instead of narrowing to a subset', async () => {
    // A source that never stops paging. Returning what we have would hide conversations with nothing on
    // screen saying so — a narrowing that is too NARROW is worse than one that is too wide.
    const { client } = clientWith([{ assignments: [{ brandId: 'b', playerId: 'p' }], nextPageToken: 'more' }]);

    await expect(client.attachedPlayersOfCaller(md())).rejects.toThrow(MembershipUnavailableError);
  });
});

describe('empty and unknown are different answers (FR-006)', () => {
  it('an absent list means "no attachments" — a real, empty answer', async () => {
    const { client } = clientWith([{}]);
    await expect(client.attachedPlayersOfCaller(md())).resolves.toEqual([]);
  });

  it('an unreadable list is an ERROR, never an empty portfolio', async () => {
    const { client } = clientWith([{ assignments: 'nope' as unknown }]);
    await expect(client.attachedPlayersOfCaller(md())).rejects.toThrow(MembershipUnavailableError);
  });

  it('a transport failure is an ERROR — an unnarrowed list must never follow from it', async () => {
    const users = { listAssignedPlayers: () => throwError(() => new Error('ECONNREFUSED')) };
    const client = new PersonMembersClient({ getService: () => users } as never);
    client.onModuleInit();

    await expect(client.attachedPlayersOfCaller(md())).rejects.toThrow(MembershipUnavailableError);
  });

  it('⚠️ a gRPC refusal is rethrown AS-IS, so a 403 stays a 403', async () => {
    // Flattening this into "unavailable" would tell a caller who simply lacks a permission that the
    // server had broken — the live-run defect this file's sibling records.
    const denied = Object.assign(new Error('denied'), { code: 7 });
    const users = { listAssignedPlayers: () => throwError(() => denied) };
    const client = new PersonMembersClient({ getService: () => users } as never);
    client.onModuleInit();

    await expect(client.attachedPlayersOfCaller(md())).rejects.toBe(denied);
  });
});

describe('the provider token is unchanged', () => {
  it('reuses the existing users channel rather than opening a third one', () => {
    // No new configuration and no new channel: `USERS_GRPC_TARGET` has been a refuse-to-start
    // requirement since feature 016, and this is simply another read on the same client.
    expect(CHATS_PERSON_CLIENT).toBe('CHATS_PERSON_CLIENT');
  });
});
