import { Metadata } from '@grpc/grpc-js';
import { of, throwError } from 'rxjs';
import { type ClientGrpc } from '@nestjs/microservices';
import { MembershipUnavailableError, PersonMembersClient } from './person-members.client';

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', 'crm.inbox.view,crm.contact.view');
  return m;
}

function makeClient(listPersonMembers: jest.Mock) {
  const grpc = { getService: () => ({ listPersonMembers }) } as unknown as ClientGrpc;
  const client = new PersonMembersClient(grpc);
  client.onModuleInit();
  return client;
}

/**
 * Feature 022 (roadmap 4.13), T038 — **chats asks users which records are one human, and fails closed.**
 *
 * ── Why this call exists at all ─────────────────────────────────────────────────────────────────
 * Feature 020 decided that a human across brands is an EXPLICITLY linked `Person` — never an id match —
 * and put the link in `users_db`. `chats` owns conversations and cannot join across databases
 * (Principle VIII), so identity crosses as a gRPC call. The users proto has said so since 020 in as many
 * words: *"Chats needs it to answer a person's conversation feed … the same way chats already dials this
 * service for uploads."* The call was designed, described, and never made.
 *
 * ── Why fail-closed is the load-bearing behaviour ───────────────────────────────────────────────
 * "The source is down" and "there is nothing there" are indistinguishable to a naive caller, and only one
 * of them is safe to treat as an answer. An aggregate computed over the members that HAPPENED to resolve
 * would be a statement about a subset of a human while looking like a statement about the human — worse
 * than an error, because nobody would investigate it. This is the same rule `auth.client.ts` already
 * applies to a rule author's authority (`AuthorityUnavailableError`), for the same reason.
 */
describe('PersonMembersClient', () => {
  it('returns the member identities users reports', async () => {
    const rpc = jest.fn().mockReturnValue(
      of({
        members: [
          { brandId: 'brand-a', playerId: 'p1' },
          { brandId: 'brand-b', playerId: 'p2' },
        ],
      }),
    );
    const members = await makeClient(rpc).membersOf('person-1', md());
    expect(members).toEqual([
      { brandId: 'brand-a', playerId: 'p1' },
      { brandId: 'brand-b', playerId: 'p2' },
    ]);
  });

  it('FORWARDS the caller’s own metadata unchanged, so users enforces crm.contact.view itself', async () => {
    // The permission that gates "these two records are one person" belongs to `users`, and it is
    // `crm.contact.view` — NOT the inbox key. Calling as a system actor to avoid it would launder the
    // permission: an inbox-only caller would learn through the person feed exactly what the contact key
    // exists to gate (research R5).
    const rpc = jest.fn().mockReturnValue(of({ members: [] }));
    const metadata = md();
    await makeClient(rpc).membersOf('person-1', metadata);
    const [, passed] = rpc.mock.calls[0] as [unknown, Metadata];
    expect(passed).toBe(metadata);
    expect(passed.get('x-actor-permissions')[0]).toContain('crm.contact.view');
  });

  it('an EMPTY member list is a real answer — a person may legitimately have none', async () => {
    const rpc = jest.fn().mockReturnValue(of({ members: [] }));
    await expect(makeClient(rpc).membersOf('person-1', md())).resolves.toEqual([]);
  });

  it('a MISSING members field is NOT an empty list — it is an unreadable response', async () => {
    // The distinction that matters: absent data and no data look identical on the wire, and treating the
    // first as the second is how a person-level read would quietly narrow to nothing.
    const rpc = jest.fn().mockReturnValue(of({}));
    await expect(makeClient(rpc).membersOf('person-1', md())).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it('a transport failure raises MembershipUnavailableError, never an empty result', async () => {
    const rpc = jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    await expect(makeClient(rpc).membersOf('person-1', md())).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it('a REFUSAL from users is rethrown with its status, so the caller maps 403 to 403', async () => {
    // A caller lacking `crm.contact.view` must receive a refusal — not "this person has no members",
    // which would look like a legitimately unlinked customer.
    const denied = Object.assign(new Error('forbidden'), { code: 7 });
    const rpc = jest.fn().mockReturnValue(throwError(() => denied));
    await expect(makeClient(rpc).membersOf('person-1', md())).rejects.toBe(denied);
  });

  it('the error carries no player id, no brand and no response body (SEC-26)', async () => {
    const rpc = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('connect ECONNREFUSED 10.1.2.3:50052')));
    try {
      await makeClient(rpc).membersOf('person-secret-1', md());
      throw new Error('should have refused');
    } catch (err) {
      const text = `${(err as Error).name} ${(err as Error).message}`;
      expect(text).not.toContain('person-secret-1');
      expect(text).not.toContain('10.1.2.3');
    }
  });

  it('an empty person id never reaches the wire', async () => {
    // Nothing to ask about, and the answer is the same "no members" a caller would get anyway. Asking
    // would spend a round trip to learn it.
    const rpc = jest.fn();
    await expect(makeClient(rpc).membersOf('', md())).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('drops a member row missing either half of the identity', async () => {
    // A customer record is `(brand, player)`; half of one identifies nobody. Dropping it rather than
    // passing a half-filled pair keeps the 5.2 rule intact — a player id alone must never select rows.
    const rpc = jest.fn().mockReturnValue(
      of({
        members: [
          { brandId: 'brand-a', playerId: 'p1' },
          { brandId: '', playerId: 'p2' },
          { brandId: 'brand-c' },
        ],
      }),
    );
    await expect(makeClient(rpc).membersOf('person-1', md())).resolves.toEqual([
      { brandId: 'brand-a', playerId: 'p1' },
    ]);
  });
});
