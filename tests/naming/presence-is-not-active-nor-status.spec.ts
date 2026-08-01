import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';
import { parseSchema } from '../data-model/schema-scan';

/**
 * T058 (feature 025, roadmap 5.9 — FR-034/FR-035): **presence is not `active`, and it is not
 * "status".**
 *
 * ── The collision that was already inside the query ─────────────────────────────────────────────
 * `Operator.active` means *the staff account is not deactivated* (roadmap 3.16). Presence means
 * *this person is at their desk right now*. `OperatorRepository.resolveByAuthUserIds` reads BOTH —
 * it is the one query where they meet — and conflating them would make a person at lunch
 * indistinguishable from a person who left the company.
 *
 * ── And the word "status" was already taken three times ─────────────────────────────────────────
 * A conversation's status (ADR 0040), an escalation's status, and `TransitionStatus` in the
 * transition catalogue. A fourth meaning is how a reader becomes certain they already know what they
 * are looking at — the shape this project paid for with `Player.preferences_json` (021),
 * `personalizeGroup` (024) and brand (020). The recorded lesson each time: *"the name is taken" is
 * precisely what makes the next person assume the thing is already built.*
 */

const REPO_ROOT = resolve(__dirname, '../..');
const PRESENCE_DIR = 'services/users/src/presence';
const abs = (p: string) => resolve(REPO_ROOT, p);
const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');
const read = (p: string) => stripComments(readFileSync(abs(p), 'utf8'));

const PRESENCE_FILES = [
  `${PRESENCE_DIR}/presence.repository.ts`,
  `${PRESENCE_DIR}/presence.service.ts`,
  `${PRESENCE_DIR}/presence-sweep.service.ts`,
  `${PRESENCE_DIR}/presence.grpc.controller.ts`,
  `${PRESENCE_DIR}/presence.read.controller.ts`,
  `${PRESENCE_DIR}/labels.repository.ts`,
  'libs/common/src/presence/states.ts',
];

describe('the presence vocabulary keeps its distance from two taken words', () => {
  it('every file under test was actually read (anti-vacuous)', () => {
    for (const f of PRESENCE_FILES) expect(read(f).length).toBeGreaterThan(200);
  });

  it('⭐ no presence file declares a variable, field or type called `status`', () => {
    // `PresenceStatus` on the WIRE is exempt and deliberately so — it is an rpc OUTCOME (ok /
    // unchanged / forbidden), which is what "status" means everywhere else in this product too. What
    // is banned is calling the STATE a status.
    const banned = /\b(presenceStatus|presence_status)\b|\bstatus:\s*PresenceState\b/;
    const offenders = PRESENCE_FILES.filter((f) => banned.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('⭐ the schema column is `state`, and there is no presence `status` column', () => {
    const presence = parseSchema('users').find((m) => m.name === 'OperatorPresence');
    expect(presence).toBeDefined();
    const names = presence!.fields.map((f) => f.name);
    expect(names).toContain('state');
    expect(names).not.toContain('status');
  });

  it('⭐ `Operator.active` still exists and still means something else', () => {
    // If this ever fails, somebody merged the two facts — which is the failure this whole file is
    // about, and it would not announce itself anywhere else.
    const operator = parseSchema('users').find((m) => m.name === 'Operator');
    expect(operator?.fields.map((f) => f.name)).toContain('active');
  });

  it('presence does NOT carry its own `active`, so there is no second answer', () => {
    const presence = parseSchema('users').find((m) => m.name === 'OperatorPresence');
    expect(presence?.fields.map((f) => f.name)).not.toContain('active');
  });

  it('⭐ the query where the two MEET names both, and comments the distinction', () => {
    // The one place a reader can be misled, so the one place the distinction has to be written down.
    const file = 'services/users/src/operator/operator.repository.ts';
    const raw = readFileSync(abs(file), 'utf8');
    expect(raw).toMatch(/active:\s*true/);
    expect(raw).toMatch(/operatorPresence/);
    // The comment is the artefact under test here, so the text is read UNSTRIPPED on purpose.
    expect(raw).toMatch(/DIFFERENT FACTS|different facts/);
    expect(raw).toMatch(/deactivated|left/i);
  });

  it('the availability predicate takes `operatorActive` as its OWN argument', () => {
    // Three independent conditions, written as three (FR-011/FR-012/FR-019). Folding the staff-status
    // check into the state enum — an `inactive` member, say — is exactly how the two facts merge.
    const states = read('libs/common/src/presence/states.ts');
    expect(states).toMatch(/operatorActive/);
    expect(states).not.toMatch(/'inactive'|'deactivated'/);
  });

  it('the four states are exactly these, and none of them is a staff-account fact', () => {
    const states = read('libs/common/src/presence/states.ts');
    expect(states).toMatch(
      /PRESENCE_STATES\s*=\s*\[\s*'online',\s*'transfers_only',\s*'away',\s*'offline'\s*\]/,
    );
  });

  it('no presence file was named after the taken word', () => {
    // Cheap, and it catches the version of this mistake that arrives as a filename rather than a
    // symbol — which is the version nobody greps for.
    for (const f of PRESENCE_FILES) {
      expect(rel(abs(f))).not.toMatch(/operator-status|presence-status|agent-status/);
    }
  });
});
