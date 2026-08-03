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

/**
 * ⭐ **The composition root is exempt, and the exemption is the fix for a real defect.**
 *
 * As first written, this guard forbade *any* file under `app/` from naming an implementation — which
 * silently forbade the **binding itself**. So the application never performed the swap: it booted on
 * `MockDataAccess`, the Inbox asked the demo store for conversations, and it was found only by a
 * person clicking the screen on 2026-08-02.
 *
 * ⚠️ A guard strict enough to prevent the wiring it exists to protect is not strict, it is wrong. The
 * guarantee worth keeping is *"no SCREEN depends on the transport"*, and a screen is not the file
 * whose whole job is to choose one. Exactly one file is exempt, by name — widening this list is the
 * thing to argue about, not the rule.
 */
const COMPOSITION_ROOT = 'providers.tsx';
const SCREEN_FILES = UI_FILES.filter((f) => !f.endsWith(COMPOSITION_ROOT));

describe('*** no screen depends on the transport ***', () => {
  it('scanned the UI tree (guards against a silently empty scan)', () => {
    expect(UI_FILES.length).toBeGreaterThan(10);
    // …and the exemption removed exactly one file, not the whole scan.
    expect(UI_FILES.length - SCREEN_FILES.length).toBe(1);
  });

  it('no SCREEN imports the gateway transport', () => {
    // If a screen imported it, "swap the implementation" would stop being one line and start being
    // a rewrite — exactly the outcome the seam was built at 8.4 to avoid, and never verified since.
    const offenders = SCREEN_FILES.filter((f) =>
      /from\s+['"][^'"]*data\/gateway/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no SCREEN imports a concrete implementation at all', () => {
    // Including the mock: a screen that names MockDataAccess is a screen pinned to invented data.
    const offenders = SCREEN_FILES.filter((f) =>
      /\b(MockDataAccess|GatewayDataAccess)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('⭐ …and the composition root DOES bind one — the exemption is used, not just granted', () => {
    // Without this, the exemption would quietly permit the original defect to return: no screen names
    // a transport, and neither does anything else, so the app boots on the demo store again.
    const root = UI_FILES.find((f) => f.endsWith(COMPOSITION_ROOT));
    expect(root).toBeDefined();
    expect(readFileSync(root!, 'utf8')).toMatch(/new GatewayDataAccess\(/);
  });
});
