import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIORITIES } from './priorities';

/**
 * ⭐⭐ **The web's priority list must be the one the owning service enforces.**
 *
 * ── The defect this exists for ──────────────────────────────────────────────────────────────────
 * `web/src/features/inbox/columns.ts` offered four priorities — `low · normal · high · urgent` —
 * against a service that has always known three. `urgent` matched no ticket that could ever exist,
 * so the filter answered "nothing" forever, and "nothing" is exactly what a working filter says when
 * there is genuinely no urgent work. A wrong answer with no symptom.
 *
 * It was found by building the ticket's priority EDITOR: an editor cannot offer a value the server
 * refuses, which forced the two lists into the same sentence for the first time.
 *
 * ── Read as text, deliberately ──────────────────────────────────────────────────────────────────
 * `web` must not take a build dependency on `services/chats`. The file is the source of truth either
 * way, and `nav-permissions.test.ts` established this shape for exactly the same class of bug.
 */
const WIRE = join(__dirname, '..', '..', '..', 'services', 'chats', 'src', 'shared', 'wire.ts');

function servicePriorities(): string[] {
  const src = readFileSync(WIRE, 'utf8');
  const decl = /export const PRIORITIES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) throw new Error(`could not find PRIORITIES in ${WIRE}`);
  return [...decl[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('ticket priorities — the web and the service spell the same list', () => {
  it('the service really does declare a list (the regex has not gone stale)', () => {
    // Without this, a refactor that renames or reshapes the declaration turns the check below into
    // a comparison against nothing — a green test guarding an empty set.
    expect(servicePriorities().length).toBeGreaterThan(0);
  });

  it('⭐ the two lists are identical, in the same order', () => {
    expect([...PRIORITIES]).toEqual(servicePriorities());
  });

  it('⚠️ `urgent` is not among them — the value the Inbox filter used to offer', () => {
    // Pinned by name: it is the one that shipped, and a re-added `urgent` would restore a filter
    // that silently answers nothing.
    expect(PRIORITIES).not.toContain('urgent');
  });
});
