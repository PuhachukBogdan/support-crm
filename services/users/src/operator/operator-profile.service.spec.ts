import { OperatorProfileService } from './operator-profile.service';
import { OperatorProfileController } from './operator-profile.grpc.controller';
import { Metadata } from '@grpc/grpc-js';

/**
 * MVP block W1 / roadmap 5.10 — the join nobody owned.
 *
 * These assert the four properties the point's *Done when* names, at the tier that can hold them:
 * idempotence, the subject being unforgeable, an existing name surviving a re-ensure, and a refusal
 * when the caller context is absent.
 */

interface Row {
  id: string;
  account_id: string;
  auth_user_id: string;
  display_name: string | null;
  active: boolean;
}

/** A table with the real UNIQUE constraint, because the code's race arm depends on it firing. */
class FakeDb {
  rows: Row[] = [];
  private n = 0;

  private nextId(): string {
    return `op-${++this.n}`;
  }

  forAccount = (accountId: string) => {
    const rows = this.rows;
    const nextId = () => this.nextId();
    return {
      operator: {
        findFirst: ({ where }: { where: { auth_user_id: string } }) =>
          Promise.resolve(
            rows.find((r) => r.account_id === accountId && r.auth_user_id === where.auth_user_id) ??
              null,
          ),
        create: ({ data }: { data: Omit<Row, 'id' | 'active'> }) => {
          if (
            rows.some(
              (r) => r.account_id === data.account_id && r.auth_user_id === data.auth_user_id,
            )
          ) {
            return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
          }
          const row: Row = { id: nextId(), active: true, ...data } as Row;
          rows.push(row);
          return Promise.resolve(row);
        },
      },
    };
  };
}

const md = (account: string, user: string) => {
  const m = new Metadata();
  if (account) m.set('x-actor-account-id', account);
  if (user) m.set('x-actor-user-id', user);
  return m;
};

describe('EnsureOwnOperator (roadmap 5.10)', () => {
  let db: FakeDb;
  let svc: OperatorProfileService;
  let ctl: OperatorProfileController;

  beforeEach(() => {
    db = new FakeDb();
    svc = new OperatorProfileService(db as never);
    ctl = new OperatorProfileController(svc);
  });

  it('creates a profile for a person who has none — the case that made an invited AM unassignable', async () => {
    const res = await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));

    expect(res.operatorId).toBeTruthy();
    expect(res.accountId).toBe('acc-1');
    expect(res.active).toBe(true);
    expect(db.rows).toHaveLength(1);
    // NULL rather than a guessed name: `auth.User.display_name` owns that fact.
    expect(db.rows[0]!.display_name).toBeNull();
  });

  it('is idempotent — a second call returns the SAME profile and creates no twin', async () => {
    const first = await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));
    const second = await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));

    expect(second.operatorId).toBe(first.operatorId);
    expect(db.rows).toHaveLength(1);
  });

  it('never overwrites an existing display name — a login must not undo the person’s own edit', async () => {
    await svc.ensureOwn('acc-1', 'user-1', 'Original'); // as the seed or a future HR feed would set it
    const again = await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));

    expect(again.displayName).toBe('Original');
    expect(db.rows[0]!.display_name).toBe('Original');
  });

  it('⭐ the subject cannot be pointed at anyone else — a rogue body changes nothing', async () => {
    // The guarantee is structural: the row is keyed on METADATA, and the wire type has no identity
    // field at all. A body that invents one is ignored rather than trusted.
    await ctl.ensureOwnOperator(
      { authUserId: 'somebody-else', accountId: 'other-acc' } as unknown as Record<string, never>,
      md('acc-1', 'caller'),
    );

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.auth_user_id).toBe('caller');
    expect(db.rows[0]!.account_id).toBe('acc-1');
  });

  it('refuses when the caller context is missing — a blank subject would be one shared ownerless profile', async () => {
    await expect(ctl.ensureOwnOperator({}, md('acc-1', ''))).rejects.toThrow(
      /account and an identity/,
    );
    await expect(ctl.ensureOwnOperator({}, md('', 'user-1'))).rejects.toThrow(
      /account and an identity/,
    );
    expect(db.rows).toHaveLength(0);
  });

  it('two accounts holding the same auth id are two profiles — isolation is not bypassed by the pair', async () => {
    await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));
    await ctl.ensureOwnOperator({}, md('acc-2', 'user-1'));

    expect(db.rows).toHaveLength(2);
  });

  it('a lost create race resolves to the winner’s row instead of failing the caller', async () => {
    // Simulate the overlap the two call sites can genuinely produce: the row appears between our
    // read and our write, so `create` raises P2002 and the code must re-read rather than throw.
    db.rows.push({
      id: 'op-winner',
      account_id: 'acc-1',
      auth_user_id: 'user-1',
      display_name: null,
      active: true,
    });
    const original = db.forAccount.bind(db);
    let firstRead = true;
    (db as unknown as { forAccount: FakeDb['forAccount'] }).forAccount = (acc: string) => {
      const real = original(acc);
      return {
        operator: {
          findFirst: (args: Parameters<typeof real.operator.findFirst>[0]) => {
            if (firstRead) {
              firstRead = false;
              return Promise.resolve(null); // the pre-write read misses
            }
            return real.operator.findFirst(args);
          },
          create: real.operator.create,
        },
      } as ReturnType<FakeDb['forAccount']>;
    };

    const res = await ctl.ensureOwnOperator({}, md('acc-1', 'user-1'));

    expect(res.operatorId).toBe('op-winner');
    expect(db.rows).toHaveLength(1);
  });
});
