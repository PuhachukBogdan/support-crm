import { ProvisioningRepository } from './provisioning.repository';
import type { PrismaService } from '../prisma.service';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §7) — **the HR↔user binding, against BOTH unique constraints.**
 *
 * ── The defect this exists because of ───────────────────────────────────────────────────────────
 * `StaffIdentity` is unique on `(account, hr_employee_id)` AND on `(account, user_id)`. The first
 * implementation upserted on the first pair only, so the moment HR sent a NEW employee number for
 * somebody already bound — a re-hire, the case §7 is written for — it found no row for the new id,
 * tried to create one, and violated the per-user constraint. The caller got a 500 and the binding
 * never happened, which meant the later `DELETE /staff/{new id}` answered «unknown employee»: an
 * offboarding that reported cleanly and did nothing.
 *
 * ⚠️ It survived the unit suite AND the first live pass. The suite faked the repository, and the
 * first live run used a person with no previous binding — the collision needs a SECOND run. Found on
 * the second, which is the argument for running a live check twice rather than once.
 *
 * The fake below models the two constraints rather than recording calls, because a fake that stores
 * whatever it is handed cannot fail on the thing the database refuses.
 */

type Row = { account_id: string; hr_employee_id: string; user_id: string };

function fakePrisma(rows: Row[]) {
  const byPair = (r: Row, a: string, hr: string) => r.account_id === a && r.hr_employee_id === hr;
  const store = {
    staffIdentity: {
      deleteMany: jest.fn(async ({ where }: { where: { account_id: string; user_id: string; hr_employee_id: { not: string } } }) => {
        // «This account, this person, any OTHER employee number» — the predicate the repository sends.
        const doomed = (r: Row) =>
          r.account_id === where.account_id &&
          r.user_id === where.user_id &&
          r.hr_employee_id !== where.hr_employee_id.not;
        const keep = rows.filter((r) => !doomed(r));
        const count = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count };
      }),
      upsert: jest.fn(async ({ where, create, update }: {
        where: { account_id_hr_employee_id: { account_id: string; hr_employee_id: string } };
        create: Row;
        update: { user_id: string };
      }) => {
        const key = where.account_id_hr_employee_id;
        const found = rows.find((r) => byPair(r, key.account_id, key.hr_employee_id));
        if (found) {
          found.user_id = update.user_id;
          return found;
        }
        // ⚠️ The SECOND constraint, which the first implementation did not survive.
        if (rows.some((r) => r.account_id === create.account_id && r.user_id === create.user_id)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        rows.push({ ...create });
        return create;
      }),
    },
    // The transaction is what makes «drop the old, write the new» one act; run in order.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return store as unknown as PrismaService;
}

const repo = (rows: Row[]) => new ProvisioningRepository(fakePrisma(rows));

describe('binding an HR employee id to a person', () => {
  it('binds a person nobody has bound before', async () => {
    const rows: Row[] = [];
    await repo(rows).bindEmployee('acc-1', 'E-1', 'user-1');
    expect(rows).toEqual([{ account_id: 'acc-1', hr_employee_id: 'E-1', user_id: 'user-1' }]);
  });

  it('re-binding the identical pair is a no-op, not a duplicate', async () => {
    const rows: Row[] = [{ account_id: 'acc-1', hr_employee_id: 'E-1', user_id: 'user-1' }];
    await repo(rows).bindEmployee('acc-1', 'E-1', 'user-1');
    expect(rows).toHaveLength(1);
  });

  it('*** ⭐ a NEW employee number for the same person re-points the binding ***', async () => {
    const rows: Row[] = [{ account_id: 'acc-1', hr_employee_id: 'E-old', user_id: 'user-1' }];
    await repo(rows).bindEmployee('acc-1', 'E-new', 'user-1');
    // The newest number wins and the old one stops resolving — that employment instance is over, and
    // a termination event quoting it must not be able to close the new one (§7).
    expect(rows).toEqual([{ account_id: 'acc-1', hr_employee_id: 'E-new', user_id: 'user-1' }]);
  });

  it('*** and one person never ends up with two employee numbers ***', async () => {
    const rows: Row[] = [{ account_id: 'acc-1', hr_employee_id: 'E-old', user_id: 'user-1' }];
    await repo(rows).bindEmployee('acc-1', 'E-new', 'user-1');
    expect(rows.filter((r) => r.user_id === 'user-1')).toHaveLength(1);
  });

  it('another account’s binding for the same numbers is untouched (Principle I)', async () => {
    const rows: Row[] = [
      { account_id: 'acc-2', hr_employee_id: 'E-old', user_id: 'user-1' },
      { account_id: 'acc-1', hr_employee_id: 'E-old', user_id: 'user-1' },
    ];
    await repo(rows).bindEmployee('acc-1', 'E-new', 'user-1');
    expect(rows).toContainEqual({ account_id: 'acc-2', hr_employee_id: 'E-old', user_id: 'user-1' });
  });
});
