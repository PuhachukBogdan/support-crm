import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { ConversationReadController } from './conversation.grpc.controller';
import { ConversationRepository } from './conversation.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { PersonMembersClient } from '../person/person-members.client';
import type { SlaRepository } from '../sla/sla.repository';

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
