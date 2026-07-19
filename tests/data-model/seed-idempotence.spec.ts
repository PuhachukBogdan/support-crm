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
