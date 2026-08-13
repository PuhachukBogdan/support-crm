import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ⭐⭐ W27 / 036 (FR-002/FR-003) — the STRUCTURAL walk: every query that feeds work excludes shelved
 * conversations, via the ONE predicate `shelf.ts` exports. A per-file exclusion is one the next list
 * forgets; this spec is what makes "a future list cannot forget it" a build failure instead of a
 * code-review hope.
 *
 * The enumeration mirrors research.md R5. A site is held to TWO facts: it imports the shared value,
 * and it spreads it into a `where` (importing alone decorates; spreading excludes). The exports site
 * is different in kind — it EXCLUDES BY NOT MAPPING (the producer rides the same repository list,
 * whose default is the exclusion), so what is asserted there is the absence of a mapping plus the
 * comment that keeps the absence deliberate.
 */
const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const SPREAD_SITES = [
  'src/conversation/conversation.repository.ts', // the list every screen and the export producer ride
  'src/conversation/inbox-unseen.repository.ts', // the unread badge count
  'src/assignment/backlog.ts', // enqueue (the front door) + waiting (the drain's read)
  'src/assignment/group-pool.ts', // the capacity/load count
];

describe('⭐ every work-feeding query spreads the ONE exclusion (structural, R5)', () => {
  it.each(SPREAD_SITES)('%s imports NOT_SHELVED and spreads it into a where', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/import \{[^}]*NOT_SHELVED[^}]*\} from '[^']*shelf'/);
    expect(src).toMatch(/\.\.\.NOT_SHELVED/);
  });

  it('backlog spreads it at BOTH doors — enqueue and the drain read', () => {
    const src = read('src/assignment/backlog.ts');
    expect(src.match(/\.\.\.NOT_SHELVED/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the repository default is the exclusion, and the bucket filter is the ONLY replacement', () => {
    const src = read('src/conversation/conversation.repository.ts');
    // The where is BORN from the shelf decision — not a filter appended later that a refactor drops.
    expect(src).toMatch(/f\.shelved\s*\?\s*\{\s*shelved_state:\s*f\.shelved\s*\}\s*:\s*\{\s*\.\.\.NOT_SHELVED\s*\}/);
  });

  it('exports MIRROR the filter — with its permission — and the read hop maps it (FR-027)', () => {
    // The first draft excluded exports by not mapping the filter; the parity guard
    // (tests/exports/filter-parity.spec.ts) refused it, and it was right: a supervisor exporting
    // the Suspended bucket would have received a file with NONE of the rows on screen — the same
    // SEC-AP2 lie inverted. So the mirror is total: accepted+validated+permission-gated at the
    // chats edge, stored, and read back by `filtersOf` (the slaOutcome drop, guarded against).
    const edge = read('src/export/export.grpc.controller.ts');
    expect(edge).toMatch(/isShelfState\(shelved\)/);
    expect(edge).toMatch(/hasPermission\(permissions, 'crm\.conversation\.shelf\.view'\)/);
    const service = read('src/export/export.service.ts');
    expect(service).toMatch(/raw\.shelved/);
    // The default stays the exclusion: no filter ⇒ the producer rides the repository's NOT_SHELVED.
  });

  it('anti-vacuous: the predicate these sites spread is the real column', () => {
    const shelf = read('src/conversation/shelf.ts');
    expect(shelf).toMatch(/NOT_SHELVED = \{ shelved_state: null \}/);
  });
});

describe('⭐ the mutation freeze has no side doors (FR-007, structural)', () => {
  // Every operator-actor mutation entry calls the guard. The delivery path is EXEMPT by design
  // (FR-012) and asserted as such below — an exemption nobody wrote down becomes a defect report.
  const GUARDED = [
    ['src/conversation/conversation.write.controller.ts', 6], // status/brand/player/detach/subject/priority
    ['src/assignment/assignment.grpc.controller.ts', 1], // manual assign
    ['src/assignment/auto-assign.grpc.controller.ts', 1], // the router's direct door
    ['src/labels/labels.grpc.controller.ts', 1], // attach+detach share assertConversation
    ['src/macros/macros.grpc.controller.ts', 1], // the bundle of refused writes
    ['src/message/message.grpc.controller.ts', 1], // PostMessage (operator path)
  ] as const;

  it.each(GUARDED)('%s calls assertNotShelved (≥%i times)', (rel, times) => {
    const calls = read(rel).match(/assertNotShelved\(/g)?.length ?? 0;
    expect(calls).toBeGreaterThanOrEqual(times);
  });

  it('⛔ the delivery path stays UNGUARDED — an inbound message on a shelved conversation is stored', () => {
    const src = read('src/message/message.grpc.controller.ts');
    // RecordIncomingMessage's handler must not gain the guard: FR-012 stores the customer's words.
    const recordIncoming = src.slice(src.indexOf("'RecordIncomingMessage'"));
    expect(recordIncoming.slice(0, 1200)).not.toMatch(/assertNotShelved/);
    // …and the exemption is written where the guard is, so it cannot read as an omission.
    expect(src).toMatch(/NOT in `assertConversationAccess`/);
  });
});
