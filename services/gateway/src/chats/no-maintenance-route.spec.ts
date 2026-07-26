import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T033 (feature 014, US2) — **fence 4: the maintenance surface has NO gateway route** (research R3).
 *
 * `ChatsMaintenanceService.SweepFirstReplySla` is the only caller of the single unscoped, cross-account
 * read in the chats service. Its safety rests on being unreachable by any client: it requires
 * `x-actor-kind: system` metadata (asserted service-side) **and** the gateway must never expose a path
 * to it.
 *
 * A structural test rather than a review note, because this is the kind of thing a well-meaning future
 * change adds ("let admins trigger a sweep manually") without anyone connecting it to tenant isolation.
 * That change should fail here, next to the reasoning.
 */
const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC);

describe('the gateway exposes no route to the chats maintenance surface', () => {
  it('finds gateway sources to inspect (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never names the maintenance gRPC service', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toContain('ChatsMaintenanceService');
    }
  });

  it('never calls the sweep RPC', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toContain('sweepFirstReplySla');
      expect(src).not.toContain('SweepFirstReplySla');
    }
  });

  it('declares no route whose path mentions a sweep or maintenance', () => {
    const routeDecorator = /@(Get|Post|Put|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(routeDecorator)) {
        const path = (m[2] ?? '').toLowerCase();
        expect(path).not.toContain('sweep');
        expect(path).not.toContain('maintenance');
      }
    }
  });
});
