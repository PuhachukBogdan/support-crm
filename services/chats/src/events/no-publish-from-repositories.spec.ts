import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T012 (feature 014) — the **no-cascade invariant, enforced structurally** (FR-006 / research R4).
 *
 * The rule: only gRPC **controllers** publish domain events. The automation engine performs its
 * writes through repositories, and repositories never publish — so an automation's own writes cannot
 * emit an event, and no configuration of rules can produce a reaction chain.
 *
 * Why a structural test instead of trusting review: the alternative design was a `suppressEvents`
 * flag threaded through every write path. That is one forgotten argument away from an infinite loop
 * in production — and an infinite loop here means unbounded writes against real conversations. This
 * spec is what makes the safer design *stay* the design: the moment someone imports the dispatcher
 * into a repository, the suite goes red with a pointer to this comment.
 *
 * FAILS if a repository ever gains an event-publishing import.
 */
const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Generated Prisma client is not ours and is huge.
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const repositories = files.filter((f) => f.endsWith('.repository.ts'));

describe('no-cascade is structural: repositories cannot publish events (FR-006)', () => {
  it('finds the repositories it is supposed to police (guards against a silent zero-match pass)', () => {
    expect(repositories.length).toBeGreaterThanOrEqual(4);
  });

  it.each(repositories.map((f) => [f.slice(SRC.length + 1), f]))(
    '%s does not reference the event dispatcher',
    (_name, full) => {
      const src = readFileSync(full as string, 'utf8');
      expect(src).not.toContain('events.dispatcher');
      expect(src).not.toContain('DomainEventDispatcher');
      // …and cannot hand-roll a publish either.
      expect(src).not.toMatch(/\.publish\s*\(/);
    },
  );

  /**
   * `events.publisher.ts` is allow-listed BY NAME: it is the controller-side publish helper (three
   * controllers would otherwise hand-roll fact collection). The invariant that matters is not "one
   * file publishes" but "no **repository** publishes" — that is what makes a cascade impossible.
   * Anything else reaching for the dispatcher is a design change, and should fail here first.
   */
  it('the dispatcher is only imported by controllers, the publisher, the engine, or module wiring', () => {
    const importers = files.filter((f) => {
      if (f.endsWith('events.dispatcher.ts') || f.endsWith('.spec.ts')) return false;
      return readFileSync(f, 'utf8').includes('events.dispatcher');
    });
    expect(importers.length).toBeGreaterThan(0); // the guard must actually be looking at something
    for (const f of importers) {
      const name = f.slice(SRC.length + 1);
      expect(
        name.includes('.controller.ts') ||
          name.includes('.module.ts') ||
          name.endsWith('events.publisher.ts') ||
          name.includes('engine.ts'),
      ).toBe(true);
    }
  });
});
