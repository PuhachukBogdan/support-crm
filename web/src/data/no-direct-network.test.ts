import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// T008 [US1] — SC-006: no component may reach the network directly. Every UI file under
// components/ must go through the data-access interface, never `src/api/*`.

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('structure guard — components never import the transport layer', () => {
  it('no file under components/ imports from src/api', () => {
    const componentsDir = join(__dirname, '..', 'components');
    const files = walk(componentsDir);
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /from\s+['"](@\/api(\/|['"])|(\.\.?\/)+api\/)/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
