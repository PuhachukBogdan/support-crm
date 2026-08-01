import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T010 (feature 023, research **R1**) — **the transition stream and the automation dispatcher must
 * never converge.** The most important guard in this feature.
 *
 * ── The two things, and why the names are dangerous ──────────────────────────────────────────────
 * `services/chats/src/events/` has held `DomainEvent` since feature 014. It is in-process,
 * synchronous, **deliberately lossy** (a throwing subscriber is logged and swallowed, because a
 * broken rule must never fail the human action that triggered it) — and it legitimately carries
 * **message text in memory** (`ConversationFacts.messageText`).
 *
 * A transition is the opposite on every axis: durable, append-only, read years later, and carrying
 * **ids and enums only**.
 *
 * ── What this guard prevents ─────────────────────────────────────────────────────────────────────
 * Someone tidying up "two event systems" into one. That refactor reads as an improvement and its
 * consequence is **customer message bodies in an append-only store** — a SEC-26 breach nobody would
 * notice for years, because nothing fails and the product keeps working.
 *
 * ── Why the placement rules look contradictory, and are not ──────────────────────────────────────
 *   • the dispatcher may be published ONLY from controllers (`no-publish-from-repositories.spec.ts`)
 *     — so an automation's own writes cannot emit and cascade;
 *   • the recorder is called ONLY from inside repository transactions — so a rolled-back change
 *     leaves no record.
 * Two opposite rules protecting two different properties. Fusing the modules breaks both at once.
 */
const CHATS_SRC = join(__dirname, '..', '..', 'services', 'chats', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const read = (f: string) => stripComments(readFileSync(f, 'utf8'));
const rel = (f: string) => f.slice(CHATS_SRC.length + 1).replace(/\\/g, '/');

describe('the transition stream and the automation dispatcher stay separate (R1)', () => {
  const files = walk(CHATS_SRC);
  const transitionFiles = files.filter((f) => rel(f).startsWith('transition/'));
  const eventFiles = files.filter((f) => rel(f).startsWith('events/'));

  it('found both module trees (guards against a vacuous pass)', () => {
    // If either scan is empty this whole spec proves nothing — feature 018's lesson.
    expect(transitionFiles.length).toBeGreaterThanOrEqual(3);
    expect(eventFiles.length).toBeGreaterThanOrEqual(2);
    expect(files.length).toBeGreaterThan(30);
  });

  it('no transition file reaches the dispatcher', () => {
    const offenders = transitionFiles
      .filter((f) => /DomainEvent|events\.dispatcher|events\.publisher|DomainEventPublisher/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no events file writes a transition', () => {
    const offenders = eventFiles
      .filter((f) => /conversationTransition|TransitionRecorder|buildStatement/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the automation event type still carries message text — which is WHY they stay apart', () => {
    // Not a rule being enforced; a fact being pinned. If this ever stops being true the hazard
    // changes shape, and whoever removes it should have to read this comment first.
    const types = eventFiles.find((f) => rel(f) === 'events/events.types.ts');
    expect(types).toBeDefined();
    expect(readFileSync(types!, 'utf8')).toMatch(/messageText/);
  });

  it('its own detector works on planted samples', () => {
    expect(/DomainEvent/.test(stripComments("import { DomainEvent } from '../events/events.types';"))).toBe(true);
    // A comment mentioning the other module must NOT trip it — the whole point of stripping first,
    // because the notes explaining WHY they are separate live in these very files.
    expect(/DomainEvent/.test(stripComments('// never import DomainEvent here'))).toBe(false);
  });
});
