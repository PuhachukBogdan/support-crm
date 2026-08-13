import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { ConversationReadController } from './conversation.grpc.controller';
import { ConversationRepository } from './conversation.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { PersonMembersClient } from '../person/person-members.client';
import type { SlaRepository } from '../sla/sla.repository';
import { fakeStatusRepository } from '../status/status.fixture';
import { noOperatorIdentity, noReadMarks } from '../shared/operator-identity.fake';

/**
 * T009/T010 — the narrowing itself, through the controller (feature 030, roadmap 4.14).
 *
 * ⚠️ **Every assertion here carries its positive control.** *"The AM does not see B"* is satisfied by a
 * broken controller, a stub that returns nothing and a query that matched no rows for an unrelated
 * reason. At feature 026 the positive control was the only thing between us and shipping a security claim
 * on a lie — and that claim was this one's shape.
 */

const ROW_A = { id: 'cA', brand_id: 'b1', player_id: 'pA', status: 'open', created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z') };
const ROW_B = { id: 'cB', brand_id: 'b1', player_id: 'pB', status: 'open', created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z') };

function md(role: string): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'auth-am-1');
  m.set('x-actor-effective-role', role);
  return m;
}

/** Records the `where` it was asked for and answers with whatever the test supplies. */
function fakePrisma(rows: unknown[]) {
  // Typed with the argument so the assertions below can read the `where` the repository built — a mock
  // declared without it makes `calls[0][0]` a type error rather than a captured query.
  const findMany = jest.fn(async (args: { where?: unknown }) => (args ? rows : rows));
  const findFirst = jest.fn(async (args: { where?: unknown }) => (args ? rows[0] ?? null : null));
  const prisma = {
    forAccount: () => ({ conversation: { findMany, findFirst } }),
  } as never;
  return { prisma, findMany, findFirst };
}

const noSla = () =>
  ({ conversationIdsByOutcome: jest.fn(async () => []), getState: jest.fn(async () => null) }) as unknown as SlaRepository;

const portfolioOf = (members: Array<{ brandId: string; playerId: string }>) =>
  ({ attachedPlayersOfCaller: jest.fn(async () => members) }) as unknown as PersonMembersClient;

const ctrlWith = (rows: unknown[], person: PersonMembersClient) => {
  const f = fakePrisma(rows);
  return {
    ...f,
    ctrl: new ConversationReadController(
      new ConversationRepository(f.prisma, new TransitionRecorder()),
      noSla(),
      person,
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    ),
  };
};

describe('*** an AM is narrowed to their attached players (US1, FR-001/FR-002) ***', () => {
  it('⭐ scopes the query to the attached (brand, player) PAIRS', async () => {
    const { ctrl, findMany } = ctrlWith([ROW_A], portfolioOf([{ brandId: 'b1', playerId: 'pA' }]));

    await ctrl.listConversations({}, md('am'));

    const where = findMany.mock.calls[0]![0]!.where as { AND?: Array<{ OR?: unknown[] }> };
    // The scope is AND-ed, so no filter the caller supplies can widen it.
    expect(where.AND?.[0]?.OR).toEqual([{ brand_id: 'b1', player_id: 'pA' }]);
  });

  it('⚠️ an AM attached to NOBODY matches nothing — never the whole account', async () => {
    const { ctrl, findMany } = ctrlWith([], portfolioOf([]));

    await ctrl.listConversations({}, md('am'));

    const where = findMany.mock.calls[0]![0]!.where as { AND?: Array<{ id?: { in: string[] } }> };
    // `id: { in: [] }` and not `OR: []` — an empty OR is one refactor away from "no restriction", and
    // "no restriction" here hands over every VIP conversation in the account.
    expect(where.AND?.[0]?.id).toEqual({ in: [] });
  });

  it('⭐ POSITIVE CONTROL: an administrator gets NO scope clause at all', async () => {
    // Without this, the two assertions above would pass on a controller that narrowed everybody — and a
    // product where nobody can see anything also "does not leak".
    const person = portfolioOf([{ brandId: 'b1', playerId: 'pA' }]);
    const { ctrl, findMany } = ctrlWith([ROW_A, ROW_B], person);

    await ctrl.listConversations({}, md('admin'));

    const where = findMany.mock.calls[0]![0]!.where as { AND?: unknown[] };
    expect(where.AND).toBeUndefined();
    // And the portfolio was never even resolved: an administrator must not pay for a call they do not need.
    expect((person.attachedPlayersOfCaller as jest.Mock)).not.toHaveBeenCalled();
  });

  it('⚠️ the DETAIL path is narrowed too, and refuses as NOT_FOUND', async () => {
    // A list-only narrowing is roadmap 9.1's defect shape: the rail stopped rendering the link and the
    // route kept answering. An id is guessable from a colleague's screen or a pasted URL.
    const { ctrl } = ctrlWith([ROW_B], portfolioOf([{ brandId: 'b1', playerId: 'pA' }]));

    await expect(ctrl.getConversation({ id: 'cB' }, md('am'))).rejects.toBeInstanceOf(RpcException);
  });

  it('⭐ POSITIVE CONTROL: the same detail read SUCCEEDS once the player is attached', async () => {
    // Only the attachment changes. Without this line, the refusal above is satisfied by a broken read.
    const { ctrl } = ctrlWith([ROW_B], portfolioOf([{ brandId: 'b1', playerId: 'pB' }]));

    await expect(ctrl.getConversation({ id: 'cB' }, md('am'))).resolves.toMatchObject({ id: 'cB' });
  });

  it('⭐ T017/T018 a reassignment takes effect on the NEXT read, with no other action', async () => {
    // The scope is a live question about the attachment, not a stamp applied at ticket creation — so a
    // conversation that existed BEFORE the move follows the player.
    let members = [{ brandId: 'b1', playerId: 'pA' }];
    const person = { attachedPlayersOfCaller: jest.fn(async () => members) } as unknown as PersonMembersClient;
    const { ctrl, findMany } = ctrlWith([ROW_A, ROW_B], person);

    await ctrl.listConversations({}, md('am'));
    members = [{ brandId: 'b1', playerId: 'pB' }]; // the player moves to another AM's book
    await ctrl.listConversations({}, md('am'));

    const scopeOf = (i: number) =>
      (findMany.mock.calls[i]![0]!.where as { AND?: Array<{ OR?: unknown[] }> }).AND?.[0]?.OR;
    expect(scopeOf(0)).toEqual([{ brand_id: 'b1', player_id: 'pA' }]);
    expect(scopeOf(1)).toEqual([{ brand_id: 'b1', player_id: 'pB' }]);
  });

  it('⚠️ T019 the portfolio is NOT cached — it is resolved on every read', async () => {
    // A cached scope outlives the fact it describes, and the failure is invisible: an AM keeps seeing a
    // player who is no longer theirs. The gateway's 30-second RBAC cache already produced exactly this
    // class of false defect report at feature 017, one layer up.
    const person = portfolioOf([{ brandId: 'b1', playerId: 'pA' }]);
    const { ctrl } = ctrlWith([ROW_A], person);

    await ctrl.listConversations({}, md('am'));
    await ctrl.listConversations({}, md('am'));
    await ctrl.getConversation({ id: 'cA' }, md('am'));

    expect((person.attachedPlayersOfCaller as jest.Mock)).toHaveBeenCalledTimes(3);
  });

  it('⭐ T025/T026 the exemption follows the CLEARANCE, not a role name (US4, SC-006)', async () => {
    // `shift_am` sees am_only without masked_pii ⇒ narrowed, like `am`, without this file naming it.
    const { ctrl: shift, findMany: shiftCalls } = ctrlWith([ROW_A], portfolioOf([{ brandId: 'b1', playerId: 'pA' }]));
    await shift.listConversations({}, md('shift_am'));
    expect((shiftCalls.mock.calls[0]![0]!.where as { AND?: unknown[] }).AND).toBeDefined();

    // `super_admin` holds masked_pii — the administrative clearance — so it is exempt for the same
    // reason `admin` is. Neither role is enumerated here; the tier map decides.
    const { ctrl: owner, findMany: ownerCalls } = ctrlWith([ROW_A, ROW_B], portfolioOf([]));
    await owner.listConversations({}, md('super_admin'));
    expect((ownerCalls.mock.calls[0]![0]!.where as { AND?: unknown[] }).AND).toBeUndefined();
  });

  it('⭐ T020 a page token is bound to the SCOPE that minted it (FR-014)', async () => {
    // A scope change is the order hazard by another door: same order, different row set, so resuming
    // would silently skip or repeat rows — a plausible list nobody can see is wrong.
    let members = [{ brandId: 'b1', playerId: 'pA' }];
    const person = { attachedPlayersOfCaller: jest.fn(async () => members) } as unknown as PersonMembersClient;
    // `limit + 1` rows so the controller mints a next token.
    const many = Array.from({ length: 60 }, (_, i) => ({ ...ROW_A, id: `c${i}` }));
    const { ctrl } = ctrlWith(many, person);

    const page1 = await ctrl.listConversations({ pageSize: 50 }, md('am'));
    expect(page1.nextPageToken).not.toBe('');

    // Replaying it under the SAME portfolio is fine — the positive control, without which the refusal
    // below would be satisfied by a token that is simply always invalid.
    await expect(
      ctrl.listConversations({ pageSize: 50, pageToken: page1.nextPageToken }, md('am')),
    ).resolves.toBeDefined();

    members = [{ brandId: 'b1', playerId: 'pB' }]; // reassigned between page one and page two
    await expect(
      ctrl.listConversations({ pageSize: 50, pageToken: page1.nextPageToken }, md('am')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('⚠️ an AM may not replay a token minted while UNSCOPED', async () => {
    // Minted by an administrator (no scope slot). Accepting it for a narrowed caller would resume into a
    // sequence drawn from the whole account.
    const many = Array.from({ length: 60 }, (_, i) => ({ ...ROW_A, id: `c${i}` }));
    const { ctrl } = ctrlWith(many, portfolioOf([{ brandId: 'b1', playerId: 'pA' }]));

    const asAdmin = await ctrl.listConversations({ pageSize: 50 }, md('admin'));
    expect(asAdmin.nextPageToken).not.toBe('');

    await expect(
      ctrl.listConversations({ pageSize: 50, pageToken: asAdmin.nextPageToken }, md('am')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('⚠️ a failure to resolve the portfolio REFUSES the read — never an unnarrowed list', async () => {
    const broken = {
      attachedPlayersOfCaller: jest.fn(async () => {
        throw new Error('users unreachable');
      }),
    } as unknown as PersonMembersClient;
    const { ctrl } = ctrlWith([ROW_A, ROW_B], broken);

    // "Could not determine your portfolio" and "your portfolio is empty" must not be the same outcome:
    // an unavailable source and a genuine nothing are indistinguishable unless one of them is an error.
    await expect(ctrl.listConversations({}, md('am'))).rejects.toBeInstanceOf(RpcException);
  });
});
