import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataAccess, setDataAccess } from '../provider';
import { MockDataAccess } from '../mock/mock-data-access';
import { GatewayDataAccess } from './gateway-data-access';
import { fixturePort, loadFixture } from './fixture-port';

/**
 * T016 [US1] — SC-001: swapping the data source is one line, and no screen knows it happened.
 *
 * Two halves, because either alone is weak. The runtime half proves the swap takes effect for the
 * non-React accessor sagas use. The structural half proves screens cannot depend on the transport at
 * all — which is what makes "no screen changed" a property rather than an observation about today.
 */

const LIST = loadFixture('conversations-list-admin');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const UI_FILES = [join(__dirname, '..', '..', 'components'), join(__dirname, '..', '..', '..', 'app')]
  .flatMap(walk);

describe('the swap point', () => {
  afterEach(() => setDataAccess(new MockDataAccess()));

  it('one call redirects every consumer to the gateway implementation', async () => {
    expect(getDataAccess()).toBeInstanceOf(MockDataAccess);

    setDataAccess(new GatewayDataAccess(fixturePort([LIST]).port));

    const da = getDataAccess();
    expect(da).toBeInstanceOf(GatewayDataAccess);
    const page = await da.list('conversations', { limit: 2 });
    expect(page.items).toEqual((LIST.body as { conversations: unknown[] }).conversations);
  });

  it('and back again — the swap is not one-way', () => {
    setDataAccess(new GatewayDataAccess(fixturePort([LIST]).port));
    setDataAccess(new MockDataAccess());
    expect(getDataAccess()).toBeInstanceOf(MockDataAccess);
  });
});

describe('*** no screen depends on the transport ***', () => {
  it('scanned the UI tree (guards against a silently empty scan)', () => {
    expect(UI_FILES.length).toBeGreaterThan(10);
  });

  it('nothing under components/ or app/ imports the gateway transport', () => {
    // If a screen imported it, "swap the implementation" would stop being one line and start being
    // a rewrite — exactly the outcome the seam was built at 8.4 to avoid, and never verified since.
    const offenders = UI_FILES.filter((f) => /from\s+['"][^'"]*data\/gateway/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('nothing under components/ or app/ imports a concrete implementation at all', () => {
    // Including the mock: a screen that names MockDataAccess is a screen pinned to invented data.
    const offenders = UI_FILES.filter((f) =>
      /\b(MockDataAccess|GatewayDataAccess)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
