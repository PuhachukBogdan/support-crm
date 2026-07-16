import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// T033 — SC-005: no composite hardcodes a hex color. Styling flows only through S0 tokens.

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('composite registry — white-label (no hardcoded hex)', () => {
  it('contains no hex color literals', () => {
    const files = walk(__dirname);
    const offenders = files
      .map((f) => ({ f, hex: readFileSync(f, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g) }))
      .filter((r) => r.hex !== null);
    expect(offenders).toEqual([]);
  });
});
