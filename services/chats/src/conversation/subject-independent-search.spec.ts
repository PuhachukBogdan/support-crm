import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository, type ListFilters } from './conversation.repository';
import { TransitionRecorder } from '../transition/transition.recorder';

const ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * T034 (feature 023, FR-026 / SC-012) — **finding a conversation must never depend on its title.**
 *
 * ── Why this is a requirement and not a preference (U19) ────────────────────────────────────────
 * The title is model-generated and human-editable. Both of those are fine for a LABEL and disqualifying
 * for a KEY: an agent who renames a conversation, or a derivation that picked the wrong sentence, would
 * otherwise make it unfindable — and the failure is silent, because a search that returns nothing looks
 * exactly like a search with no matches.
 *
 * So filtering runs on message content, labels, topic and customer identifiers, and this file asserts it
 * two ways that fail independently:
 *   1. **structurally** — no query path names the column, and there is no index inviting one;
 *   2. **behaviourally** — the same filter produces the same `where` whatever the titles are.
 */

/** A fake that records the `where` it was given and answers with whatever rows the test supplies. */
function fakePrisma(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const forAccount = jest.fn().mockReturnValue({ conversation: { findMany } });
  return { prisma: { forAccount } as unknown as PrismaService, findMany };
}

const row = (id: string, subject: string | null) => ({
  id,
  brand_id: 'brand-a',
  player_id: 'p-1',
  status: 'open',
  priority: null,
  assignee_operator_id: null,
  channel: 'chat',
  created_at: new Date('2026-08-04T10:00:00.000Z'),
  updated_at: new Date('2026-08-04T10:00:00.000Z'),
  subject,
});

const FILTERS: ListFilters = {
  statusIn: ['open'],
  priority: 'normal',
  assigneeOperatorId: 'op-1',
  playerId: 'p-1',
  brandIn: ['brand-a'],
  cursor: null,
  limit: 20,
};

describe('T034 — search and filtering do not depend on the subject (FR-026 / SC-012)', () => {
  it('the same filter produces the SAME query whatever the titles are', async () => {
    const captured: unknown[] = [];
    for (const subjects of [
      [null, null], // window still open
      ['не пришёл депозит', 'вывод средств'], // real titles
      ['совершенно неверный заголовок', ''], // wrong / empty — the case U19 is about
    ]) {
      const { prisma, findMany } = fakePrisma(subjects.map((s, i) => row(`c-${i}`, s)));
      await new ConversationRepository(prisma, new TransitionRecorder()).list('acc-1', FILTERS);
      captured.push(findMany.mock.calls[0]![0]);
    }
    expect(captured[1]).toEqual(captured[0]);
    expect(captured[2]).toEqual(captured[0]);
  });

  it('the built `where` names no title column at all', async () => {
    const { prisma, findMany } = fakePrisma([]);
    await new ConversationRepository(prisma, new TransitionRecorder()).list('acc-1', FILTERS);
    const args = findMany.mock.calls[0]![0] as { where: unknown };
    const serialised = JSON.stringify(args.where);
    expect(serialised).not.toContain('subject');
  });

  it('the same conversations come back regardless of their titles', async () => {
    // The behavioural half of SC-012: identical ids out, whatever the titles were.
    const idsFor = async (subjects: (string | null)[]) => {
      const { prisma } = fakePrisma(subjects.map((s, i) => row(`c-${i}`, s)));
      const res = await new ConversationRepository(prisma, new TransitionRecorder()).list(
        'acc-1',
        FILTERS,
      );
      return res.rows.map((r) => r.id);
    };
    const present = await idsFor(['a real title', 'another']);
    const absent = await idsFor([null, null]);
    const wrong = await idsFor(['совершенно неверный', '???']);
    expect(absent).toEqual(present);
    expect(wrong).toEqual(present);
  });

  it('no query path in chats filters, orders or groups by the title', () => {
    // Structural, because the behavioural test above can only see the path it calls. A future search
    // endpoint that reached for the column would pass every test in this file except this one.
    const files = [
      'services/chats/src/conversation/conversation.repository.ts',
      'services/chats/src/contact/contact-summary.repository.ts',
      'services/chats/src/export/export.grpc.controller.ts',
      'services/chats/src/feed/feed.grpc.controller.ts',
    ];
    const offenders = files.filter((f) =>
      searchesOnSubject(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan actually read those files (a guard that scans nothing reports a clean pass)', () => {
    const owner = readFileSync(
      join(ROOT, 'services/chats/src/conversation/conversation.repository.ts'),
      'utf8',
    );
    expect(owner.length).toBeGreaterThan(1_000);
    // …and it DOES select the title, so "no match" above means "not searched on", not "not present".
    expect(stripComments(owner)).toMatch(/subject\s*:\s*true/);
  });

  it('the detector can fail — proved on planted input', () => {
    // Without this, the assertion above passes because the matcher is broken rather than because the
    // code is clean — the failure mode this project has hit three times.
    expect(
      searchesOnSubject('await db.conversation.findMany({ where: { subject: { contains: q } } });'),
    ).toBe(true);
    expect(
      searchesOnSubject('await db.conversation.findMany({ orderBy: [{ subject: "asc" }] });'),
    ).toBe(true);
    expect(searchesOnSubject('await db.conversation.groupBy({ by: ["subject"] });')).toBe(true);

    // …and the LEGITIMATE uses are not flagged. The list has to RETURN the title; it just must not
    // search on it. A guard that banned `select: { subject: true }` would ban the feature itself.
    expect(
      searchesOnSubject(
        'await db.conversation.findMany({ where: { status }, select: { subject: true } });',
      ),
    ).toBe(false);
    expect(searchesOnSubject('const x = { subject_source: null };')).toBe(false);
  });
});

/**
 * Does this source filter, order or group by the title?
 *
 * Scans the BALANCED region belonging to each `where:` / `orderBy:` / `by:` clause rather than a fixed
 * window of characters — the first version used `[^;]{0,400}?` and read straight past the end of the
 * `where` into the `select` beside it, flagging the one shape that is legitimate.
 */
function searchesOnSubject(source: string): boolean {
  const code = stripComments(source).replace(/\s+/g, ' ');
  for (const m of code.matchAll(/\b(?:where|orderBy|by)\s*:\s*(?=[[{])/g)) {
    const region = balancedFrom(code, m.index! + m[0].length);
    if (/\bsubject\b/.test(region)) return true;
  }
  return false;
}

/** The `{…}` or `[…]` starting at `start`, brace-matched. Quotes are not tracked; none appear here. */
function balancedFrom(code: string, start: number): string {
  const open = code[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    if (code[i] === open) depth += 1;
    else if (code[i] === close) {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return code.slice(start);
}
