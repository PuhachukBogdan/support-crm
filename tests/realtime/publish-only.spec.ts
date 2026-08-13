import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '../../libs/common/src';

/**
 * T015 (feature 034, W4 — FR-003) — **`chats` may PUBLISH and nothing else.**
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * This service had no Redis at all, deliberately. `export/export.maintenance.ts` records the argument:
 * *"`chats` has no Redis configuration at all, so it cannot enqueue. Rather than give it a queue client …
 * Postgres stays the source of truth."* Feature 034 opens that door by exactly one verb — a
 * fire-and-forget `PUBLISH`, which writes nothing, claims nothing and is never read back — and this guard
 * is what keeps the door that width.
 *
 * ⚠️ Without it the next person needing "just a small cache" or "just a tiny queue" finds a Redis client
 * already imported and a precedent already set. The decision this service was built on would then be gone
 * without anybody deciding to remove it, which is how architecture actually erodes.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const ROOT = resolve(__dirname, '..', '..');
const SRC = join(ROOT, 'services', 'chats', 'src');

/** The one file allowed to hold a Redis client, and the reason it is allowed. */
const PUBLISHER = join('services', 'chats', 'src', 'realtime', 'realtime.publisher.ts');

/**
 * The rule is split in two, and the split is the interesting part.
 *
 * ⚠️ **The first draft banned `.subscribe(` service-wide and immediately flagged `app.module.ts`** — where
 * the *in-process* automation dispatcher is wired (`dispatcher.subscribe(handler)`). That hit was correct
 * by the letter and wrong by the meaning: nothing about it involves Redis.
 *
 * The three available answers were: exempt the file by name (which would then hide a REAL hit in the one
 * file that wires everything), loosen the pattern until it stopped complaining (which is how a guard becomes
 * decorative), or **narrow the predicate to the capability the rule actually protects**. The third is what
 * this is — and note it narrows the PREDICATE, not the rule: nothing that was forbidden became allowed.
 */

/** Repo-wide in `chats`: a queue is a second store of work, which is what the original decision refused. */
const NO_QUEUE: ReadonlyArray<{ pattern: RegExp; capability: string }> = [
  { pattern: /\bnew\s+Queue\b/, capability: 'constructing a BullMQ queue' },
  { pattern: /\bnew\s+Worker\b/, capability: 'constructing a BullMQ worker' },
  { pattern: /\bfrom\s+['"]bullmq['"]/, capability: 'importing bullmq at all' },
];

/**
 * Inside the ONE file that holds a Redis client: it may publish, and may not consume or store.
 *
 * Scoping it here is what makes it precise — a `subscribe` in this file can only be a Redis subscribe,
 * because a Redis client is the only thing in it.
 */
const PUBLISHER_ONLY: ReadonlyArray<{ pattern: RegExp; capability: string }> = [
  { pattern: /\.\s*p?subscribe\s*\(/, capability: 'subscribing — this service publishes, it does not consume' },
  { pattern: /\.\s*(set|get|del|hset|hget|incr|expire|lpush|rpop)\s*\(/, capability: 'using Redis as a store' },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

/** Comments stripped first: this guard's own explanation names every token it bans. */
const files = [...walk(SRC)].map((f) => ({
  path: relative(ROOT, f).split(sep).join('/'),
  code: stripComments(readFileSync(f, 'utf8')),
}));

describe('the Redis door in chats is one verb wide (FR-003)', () => {
  it('scanned a non-trivial number of files — a guard over an empty set proves nothing', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(NO_QUEUE)('no file in chats is $capability', ({ pattern }) => {
    const hits = files
      // Spec files may name a capability while asserting its absence.
      .filter((f) => !f.path.includes('.spec.'))
      .filter((f) => pattern.test(f.code))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });

  it.each(PUBLISHER_ONLY)('the publisher is not $capability', ({ pattern }) => {
    const publisher = files.find((f) => f.path === PUBLISHER.split(sep).join('/'));
    // The positive control for THIS assertion: if the file moved, the test must fail loudly rather than
    // quietly checking nothing — the vacuous shape this project has hit seven times.
    expect(publisher).toBeDefined();
    expect(pattern.test(publisher!.code)).toBe(false);
  });

  /**
   * The detector's own positive control. A ban list that matches nothing is indistinguishable from one that
   * is spelled wrong.
   */
  it('the detectors recognise each forbidden capability in a planted sample', () => {
    const queueSamples = [
      'const q = new Queue("crm-x");',
      'const w = new Worker("crm-x", handler);',
      'import { Queue } from "bullmq";',
    ];
    queueSamples.forEach((sample, i) => expect(NO_QUEUE[i]!.pattern.test(sample)).toBe(true));

    expect(PUBLISHER_ONLY[0]!.pattern.test('await this.client.subscribe("x");')).toBe(true);
    expect(PUBLISHER_ONLY[0]!.pattern.test('await this.client.psubscribe("x*");')).toBe(true);
    expect(PUBLISHER_ONLY[1]!.pattern.test('await this.client.set("k", "v");')).toBe(true);
  });

  /**
   * ⓘ And the control that keeps the narrowing honest: the in-process dispatcher's `subscribe` — the hit
   * that caused this split — must still be present somewhere in the service. If it ever disappears, this
   * test fails and whoever removed it learns that a guard was shaped around it.
   */
  it('the in-process automation dispatcher still subscribes, and is not what this bans', () => {
    const dispatcherWiring = files.filter((f) => /dispatcher\s*\.\s*subscribe\s*\(/.test(f.code));
    expect(dispatcherWiring.length).toBeGreaterThan(0);
  });

  it('exactly ONE file holds a Redis client, and it is the publisher', () => {
    const holders = files
      .filter((f) => !f.path.includes('.spec.'))
      .filter((f) => /from\s+['"]ioredis['"]/.test(f.code))
      .map((f) => f.path);
    expect(holders).toEqual([PUBLISHER.split(sep).join('/')]);
  });
});
