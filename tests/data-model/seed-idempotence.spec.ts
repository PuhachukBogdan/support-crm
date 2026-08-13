import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSeed as authBuild } from '../../services/auth/prisma/seed.build';
import { buildSeed as usersBuild } from '../../services/users/prisma/seed.build';
import { buildSeed as brandsBuild } from '../../services/brands/prisma/seed.build';
import { buildSeed as chatsBuild } from '../../services/chats/prisma/seed.build';

/**
 * US2 / SC-002 (feature 008): the seed builders are DETERMINISTIC — the idempotence property. Because
 * every row uses a stable synthetic key and the runners upsert (never bare create), two builds produce
 * identical ids/values, so a re-run converges to the same state. Live idempotence (re-running against
 * real Postgres leaves data unchanged) is validated on beton-test (Track B, quickstart).
 */
describe('seed builders are deterministic (idempotence property)', () => {
  it.each([
    ['auth', authBuild],
    ['users', usersBuild],
    ['brands', brandsBuild],
    ['chats', chatsBuild],
  ])('%s: two consecutive builds are deeply equal', (_name, build) => {
    expect(build()).toEqual(build());
  });
});

/**
 * ⭐⭐ **A DETERMINISTIC BUILDER IS NOT AN IDEMPOTENT SEED, and the suite above cannot tell the
 * difference** (found 2026-08-05, re-seeding the stand for the W3 live round).
 *
 * Everything above is a property of a pure function: the same rows, built twice. It says nothing about the
 * only thing that makes a re-run safe — WHICH COLUMN each upsert matches on. `npm run seed:users` threw
 * `P2002` on a stand where people had signed in, while every test here stayed green, because the two facts
 * are unrelated: the builder was perfectly deterministic and the runner was matching the wrong column.
 *
 * ── The mechanism ───────────────────────────────────────────────────────────────────────────────
 * MVP block W1 added `@@unique([account_id, auth_user_id])` to `Operator` **and** the runtime writer that
 * fills it — `EnsureOwnOperator` does `operator.create` with a generated uuid on a person's first login. So
 * a seeded user who has logged in owns a profile under an id the seed has never heard of, and an upsert
 * keyed on the synthetic id can only INSERT, straight into the constraint. W1's own live round passed
 * because it seeded *before* anybody signed in — the one ordering where the two ids never meet.
 *
 * This is the THIRD instance of the shape in this file's neighbourhood: `Credential` (W1, fixed with the
 * same move), `Player` (feature 020, where the id-keyed upsert silently OVERWROTE the sibling row rather
 * than failing) and now `Operator`.
 *
 * ── Why this test is narrow on purpose ──────────────────────────────────────────────────────────
 * ⚠️ The wider class is real and NOT closed here: `User`, `Role`, `Group`, `Brand` and `Label` all carry a
 * `@@unique` natural key and are still seeded by `id`, and the product can create rows in each. They have
 * not bitten because no product-created row has yet collided with a synthetic one — `seed-agent1@example.test`
 * is not an address anybody invites. That is luck with an expiry date, and it wants its own roadmap point
 * rather than a silent sweep inside a deployment fix.
 */
describe('a seed runner matches on the key the PRODUCT writes, not on the row id', () => {
  const ROOT = resolve(__dirname, '..', '..');
  const usersSeed = readFileSync(join(ROOT, 'services', 'users', 'prisma', 'seed.ts'), 'utf8');

  /** The operator upsert, from `db.operator.upsert(` to the end of its call. */
  const operatorUpsert = (() => {
    const at = usersSeed.indexOf('db.operator.upsert(');
    expect(at).toBeGreaterThan(-1);
    return usersSeed.slice(at, usersSeed.indexOf('});', at));
  })();

  it('keys the operator profile on (account_id, auth_user_id) — the pair EnsureOwnOperator fills', () => {
    expect(operatorUpsert).toContain('account_id_auth_user_id');
  });

  it('does not key it on the synthetic row id, which the runtime never uses', () => {
    expect(operatorUpsert).not.toMatch(/where:\s*\{\s*id:/);
  });

  /**
   * ⚠️ The second half, and the one a reader would skip: matching on the pair means the row found is the
   * RUNTIME's, so its id is not ours. Writing our id over it would repoint a primary key that `chats`
   * references by value (`Conversation.assignee_operator_id`, a soft ref with nothing to stop it) —
   * quietly reassigning or orphaning that person's conversations. A seed makes the profile exist; it does
   * not own the identifier.
   */
  it('never writes its own id over the profile it found', () => {
    const update = operatorUpsert.slice(operatorUpsert.indexOf('update:'));
    expect(update).not.toMatch(/\bid\b\s*:/);
    expect(update).not.toContain('update: op');
  });
});
