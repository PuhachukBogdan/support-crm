import { PlayerNoteService, MAX_NOTE_LENGTH } from './player-note.service';
import type { PlayerNoteRepository, PlayerNoteRow, NewNote } from './player-note.repository';
import type { PlayerRepository } from './player.repository';
import type { OperatorRepository } from '../operator/operator.repository';
import type { AssignmentRepository, PlayerRef } from '../assignment/assignment.repository';

/**
 * W35 / feature 040 — the notes service: who may read, who may write, and what the detector does.
 *
 * ── Why one file for four requirements ───────────────────────────────────────────────────────────
 * They are relationships between the same three moving parts (the clearance, the row, the audit
 * entry). *"A flagged note writes one entry and an ordinary one writes none"* is not a fact about
 * either half alone, and two fakes would let the halves disagree about what "flagged" means.
 *
 * ⚠️ The fake store hands back COPIES. Prisma returns a fresh row per query, and a fake returning live
 * references lets a later write retroactively change what a caller already read — the mistake feature
 * 025's first draft made, which reported a product defect that did not exist.
 *
 * ⚠️ **And the fake is deliberately NOT more permissive than the library.** `append` here refuses a
 * duplicate `client_ref` exactly as the unique index does, because a fake that permits what the database
 * forbids is the silent failure mode: the feature looks testable and is inert
 * (`gotchas/a-fake-more-permissive-than-the-library`, twice now).
 */

const PLAYER: PlayerRef = { brandId: 'brand-a', playerId: 'ply-1' };

const AM = { userId: 'auth-am-1', effectiveRole: 'am' };
const OTHER_AM = { userId: 'auth-am-2', effectiveRole: 'am' };
const AGENT = { userId: 'auth-agent-1', effectiveRole: 'support_agent' };
const LEAD = { userId: 'auth-lead-1', effectiveRole: 'teamlead' };
const ADMIN = { userId: 'auth-admin-1', effectiveRole: 'admin' };

function makeStore(opts: { attachedTo?: string[]; playerExists?: boolean; rows?: PlayerNoteRow[] } = {}) {
  const attachedTo = opts.attachedTo ?? [AM.userId];
  const rows: PlayerNoteRow[] = opts.rows ?? [];
  const refs = new Set(rows.map(() => ''));
  const audits: Array<Record<string, unknown>> = [];
  let seq = rows.length;

  const notes = {
    // ⚠️ The fake HONOURS `limit`, because the real query's `take` does. A fake that returned everything
    // would be more permissive than the library, and the clamp test below would pass on a service that
    // never clamped (`gotchas/a-fake-more-permissive-than-the-library`).
    async listForPlayer(_a: string, p: PlayerRef, limit: number) {
      return rows
        .filter((r) => r.brand_id === p.brandId && r.player_id === p.playerId)
        .sort((x, y) => y.created_at.getTime() - x.created_at.getTime())
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async findByClientRef(_a: string, clientRef: string) {
      const found = rows.find((r) => (r as PlayerNoteRow & { client_ref?: string }).client_ref === clientRef);
      return found ? { ...found } : null;
    },
    async append(accountId: string, note: NewNote, writeAudit?: (tx: unknown) => Promise<void>) {
      // The unique index, honoured by the fake (see the header).
      if (refs.has(note.clientRef)) throw new Error('duplicate client_ref');
      refs.add(note.clientRef);
      seq += 1;
      const row = {
        id: `note-${seq}`,
        brand_id: note.player.brandId,
        player_id: note.player.playerId,
        body: note.body,
        author_auth_user_id: note.authorAuthUserId,
        pattern_kinds: note.patternKinds,
        created_at: new Date(`2026-08-13T10:0${seq}:00Z`),
        client_ref: note.clientRef,
      } as PlayerNoteRow & { client_ref: string };
      rows.push(row);
      if (writeAudit) await writeAudit(txWith(audits));
      return { ...row };
    },
  } as unknown as PlayerNoteRepository;

  const players = {
    async getPlayer() {
      return (opts.playerExists ?? true) ? { player_id: PLAYER.playerId } : null;
    },
  } as unknown as PlayerRepository;

  const operators = {
    async namesByAuthUserIds(_a: string, ids: readonly string[]) {
      // Mirrors the real read: NO `active` filter, and an unknown identity is simply absent.
      return ids
        .filter((i) => i === AM.userId || i === OTHER_AM.userId)
        .map((i) => ({ authUserId: i, displayName: i === AM.userId ? 'Anna M' : 'Boris M' }));
    },
  } as unknown as OperatorRepository;

  const assignments = {
    async isAttached(_a: string, _p: PlayerRef, who: string) {
      return attachedTo.includes(who);
    },
  } as unknown as AssignmentRepository;

  return {
    service: new PlayerNoteService(notes, players, operators, assignments),
    rows,
    audits,
  };
}

const txWith = (audits: Array<Record<string, unknown>>) => ({
  auditEntry: {
    create: async (a: Record<string, unknown>) => {
      audits.push(a);
    },
  },
});

const ref = (n: number) => `ref-${n}`;

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The POSITIVE control first. "It was refused" is satisfied by every kind of brokenness — a route that
 * never existed, a fake that throws, a player that is not there. Prove the write works before proving
 * anybody is stopped (the standing rule, learnt the expensive way).
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('⭐ the attached manager can write and read a note (the positive control)', () => {
  it('stores it, signs it, and reads it back with the author NAME', async () => {
    const { service, rows } = makeStore();

    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'клиент играет по выходным', acknowledged: false, clientRef: ref(1) },
      AM,
    );
    expect(outcome.status).toBe('stored');
    expect(rows).toHaveLength(1);

    const list = await service.list('acc-1', PLAYER, AM);
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toBe('клиент играет по выходным');
    expect(list[0]!.author_auth_user_id).toBe(AM.userId);
    expect(list[0]!.author_display_name).toBe('Anna M');
    expect(list[0]!.pattern_kinds).toBe('');
  });

  it('the stored note comes back readable, so the screen can show it before any refresh', async () => {
    const { service } = makeStore();
    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'перезвонить в среду', acknowledged: false, clientRef: ref(2) },
      AM,
    );
    expect(outcome.status === 'stored' && outcome.note.author_display_name).toBe('Anna M');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * Clearance — the `am_only` question about THIS record, and nothing else.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('*** the page size is honoured and CLAMPED, never ignored ***', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `n-${i}`,
      brand_id: PLAYER.brandId,
      player_id: PLAYER.playerId,
      body: `note ${i}`,
      author_auth_user_id: AM.userId,
      pattern_kinds: '',
      created_at: new Date(2026, 7, 13, 10, i),
    })) as PlayerNoteRow[];

  it('a smaller ask is respected', async () => {
    const { service } = makeStore({ rows: many(10) });
    expect(await service.list('acc-1', PLAYER, AM, 3)).toHaveLength(3);
  });

  it('a larger ask is clamped to the product’s cap, not the caller’s', async () => {
    const { service } = makeStore({ rows: many(60) });
    expect((await service.list('acc-1', PLAYER, AM, 10_000)).length).toBeLessThanOrEqual(50);
  });

  it('no ask means the default page', async () => {
    const { service } = makeStore({ rows: many(60) });
    expect((await service.list('acc-1', PLAYER, AM)).length).toBe(50);
  });
});

describe('*** notes are read by the same rule as any other AM field (FR-004) ***', () => {
  it('an UNATTACHED manager is refused — the tier narrows per record, not per role', async () => {
    const { service } = makeStore({ attachedTo: [AM.userId] });
    await expect(service.list('acc-1', PLAYER, OTHER_AM)).rejects.toThrow();
  });

  it.each([
    ['support_agent', AGENT],
    ['teamlead', LEAD],
  ])('%s is refused even when attached (the tier, not the attachment, decides for them)', async (_n, caller) => {
    const { service } = makeStore({ attachedTo: [caller.userId] });
    await expect(service.list('acc-1', PLAYER, caller)).rejects.toThrow();
  });

  it('an ADMIN reads without any attachment — the administrative clearance is the policy’s own derivation', async () => {
    const { service } = makeStore({ attachedTo: [] , rows: [] });
    await expect(service.list('acc-1', PLAYER, ADMIN)).resolves.toEqual([]);
  });

  it('an unknown role is refused (fail-closed: absence degrades to open-only by policy)', async () => {
    const { service } = makeStore({ attachedTo: ['auth-x'] });
    await expect(service.list('acc-1', PLAYER, { userId: 'auth-x', effectiveRole: '' })).rejects.toThrow();
  });

  it('WRITING is refused for the same callers, not merely hidden', async () => {
    const { service, rows } = makeStore({ attachedTo: [AM.userId] });
    await expect(
      service.add('acc-1', PLAYER, { body: 'x', acknowledged: false, clientRef: ref(3) }, AGENT),
    ).rejects.toThrow();
    // The negative control's other half: nothing was written on the way to the refusal.
    expect(rows).toHaveLength(0);
  });

  it('the refusal carries nothing about the notes — not even how many exist', async () => {
    const rows = [
      {
        id: 'n-1',
        brand_id: PLAYER.brandId,
        player_id: PLAYER.playerId,
        body: 'секрет',
        author_auth_user_id: AM.userId,
        pattern_kinds: '',
        created_at: new Date('2026-08-13T09:00:00Z'),
      } as PlayerNoteRow,
    ];
    const { service } = makeStore({ attachedTo: [AM.userId], rows });
    // An empty page would be an ANSWER about a customer; the message must be the same `forbidden` every
    // other refusal in this service gives, and must not vary with what is stored.
    await expect(service.list('acc-1', PLAYER, AGENT)).rejects.toMatchObject({
      message: expect.not.stringContaining('секрет'),
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The detector round trip (FR-006…FR-008) — warn, record, still save.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('*** contact-shaped text warns FIRST and stores NOTHING (U17) ***', () => {
  it('a phone number answers needs_acknowledgement, names the kind, and writes no row', async () => {
    const { service, rows, audits } = makeStore();
    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'звонить на +34 600 123 456', acknowledged: false, clientRef: ref(4) },
      AM,
    );
    expect(outcome).toEqual({ status: 'needs_acknowledgement', kinds: ['phone'] });
    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('the acknowledged request stores it AND writes exactly one audit entry', async () => {
    const { service, rows, audits } = makeStore();
    const before = audits.length;

    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'звонить на +34 600 123 456', acknowledged: true, clientRef: ref(5) },
      AM,
    );

    expect(outcome.status).toBe('stored');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pattern_kinds).toBe('phone');
    // ⚠️ The DELTA, never the absolute count: the audit store is append-only (the standing rule).
    expect(audits.length - before).toBe(1);
    expect(audits[0]!.data).toMatchObject({
      action: 'player.note_flagged',
      actor_user_id: AM.userId,
      target_ref: `${PLAYER.brandId}:${PLAYER.playerId}`,
    });
  });

  it('⭐ the audit entry contains no fragment of the note and no contact value', async () => {
    const { service, audits } = makeStore();
    const body = 'звонить на +34 600 123 456, почта ivan@example.com';
    await service.add('acc-1', PLAYER, { body, acknowledged: true, clientRef: ref(6) }, AM);

    const serialized = JSON.stringify(audits);
    // Asserted against what was actually stored, not against the code that built it (SC-005).
    expect(serialized).not.toContain('600 123 456');
    expect(serialized).not.toContain('600123456');
    expect(serialized).not.toContain('ivan@example.com');
    expect(serialized).not.toContain('звонить');
    // …and it DOES carry the kinds, so the assertion above is not passing on an empty entry.
    expect(serialized).toContain('email,phone');
  });

  it('an ORDINARY note writes no audit entry at all (FR-009 — the row is its own record)', async () => {
    const { service, audits } = makeStore();
    await service.add(
      'acc-1',
      PLAYER,
      { body: 'жалуется на сроки вывода', acknowledged: false, clientRef: ref(7) },
      AM,
    );
    expect(audits).toHaveLength(0);
  });

  it('a heeded warning leaves nothing behind — no row, no entry, and the next body stores clean', async () => {
    const { service, rows, audits } = makeStore();
    await service.add('acc-1', PLAYER, { body: 'тел +34600123456', acknowledged: false, clientRef: ref(8) }, AM);
    await service.add('acc-1', PLAYER, { body: 'просил перезвонить', acknowledged: false, clientRef: ref(9) }, AM);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pattern_kinds).toBe('');
    expect(audits).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * Validation and idempotence.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('*** a body is a body, and a retry is one row (FR-012) ***', () => {
  it.each([['', 'empty_body'], ['   ', 'empty_body'], ['\n\t ', 'empty_body']])(
    'refuses %j as %s',
    async (body, status) => {
      const { service, rows } = makeStore();
      const outcome = await service.add('acc-1', PLAYER, { body, acknowledged: false, clientRef: ref(10) }, AM);
      expect(outcome.status).toBe(status);
      expect(rows).toHaveLength(0);
    },
  );

  it('refuses a body over the bound and stores nothing', async () => {
    const { service, rows } = makeStore();
    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'x'.repeat(MAX_NOTE_LENGTH + 1), acknowledged: false, clientRef: ref(11) },
      AM,
    );
    expect(outcome.status).toBe('too_long');
    expect(rows).toHaveLength(0);
  });

  it('accepts a body exactly at the bound (the boundary is inclusive, and it is tested)', async () => {
    const { service, rows } = makeStore();
    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'x'.repeat(MAX_NOTE_LENGTH), acknowledged: false, clientRef: ref(12) },
      AM,
    );
    expect(outcome.status).toBe('stored');
    expect(rows).toHaveLength(1);
  });

  it('the same clientRef twice → ONE row, and the first row is returned', async () => {
    const { service, rows } = makeStore();
    const first = await service.add(
      'acc-1',
      PLAYER,
      { body: 'первая заметка', acknowledged: false, clientRef: ref(13) },
      AM,
    );
    const second = await service.add(
      'acc-1',
      PLAYER,
      { body: 'первая заметка', acknowledged: false, clientRef: ref(13) },
      AM,
    );
    expect(rows).toHaveLength(1);
    expect(second.status).toBe('stored');
    expect(second.status === 'stored' && second.replayed).toBe(true);
    expect(first.status === 'stored' && second.status === 'stored' && first.note.id === second.note.id).toBe(true);
  });

  it('a replayed FLAGGED note does not ask for the acknowledgement again, nor double-audit', async () => {
    const { service, rows, audits } = makeStore();
    await service.add('acc-1', PLAYER, { body: 'тел +34600123456', acknowledged: true, clientRef: ref(14) }, AM);
    const replay = await service.add(
      'acc-1',
      PLAYER,
      { body: 'тел +34600123456', acknowledged: false, clientRef: ref(14) },
      AM,
    );
    expect(replay.status).toBe('stored');
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('two IDENTICAL bodies with different refs are two facts, not a duplicate', async () => {
    const { service, rows } = makeStore();
    await service.add('acc-1', PLAYER, { body: 'та же мысль', acknowledged: false, clientRef: ref(15) }, AM);
    await service.add('acc-1', PLAYER, { body: 'та же мысль', acknowledged: false, clientRef: ref(16) }, AM);
    expect(rows).toHaveLength(2);
  });

  it('a player that does not exist is refused before the detector runs', async () => {
    const { service, rows } = makeStore({ playerExists: false });
    const outcome = await service.add(
      'acc-1',
      PLAYER,
      { body: 'тел +34600123456', acknowledged: false, clientRef: ref(17) },
      AM,
    );
    expect(outcome.status).toBe('no_such_player');
    expect(rows).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The operator's own decision of 2026-08-13: a successor reads SIGNED notes.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('⭐ after a handover the successor reads the previous manager’s notes, signed (FR-003)', () => {
  it('the author does not change with the attachment', async () => {
    const { service, rows } = makeStore({ attachedTo: [AM.userId] });
    await service.add('acc-1', PLAYER, { body: 'любит быстрый вывод', acknowledged: false, clientRef: ref(18) }, AM);

    // The handover: the portfolio moves (W32), so the OTHER manager is attached now.
    const handed = makeStore({ attachedTo: [OTHER_AM.userId], rows });
    const list = await handed.service.list('acc-1', PLAYER, OTHER_AM);

    expect(list).toHaveLength(1);
    expect(list[0]!.author_auth_user_id).toBe(AM.userId);
    expect(list[0]!.author_display_name).toBe('Anna M');
  });

  it('an author with no resolvable profile leaves the NAME empty and the reference intact', async () => {
    const rows = [
      {
        id: 'n-old',
        brand_id: PLAYER.brandId,
        player_id: PLAYER.playerId,
        body: 'написано тем, кто уже ушёл',
        author_auth_user_id: 'auth-departed-9',
        pattern_kinds: '',
        created_at: new Date('2026-08-01T09:00:00Z'),
      } as PlayerNoteRow,
    ];
    const { service } = makeStore({ attachedTo: [AM.userId], rows });
    const list = await service.list('acc-1', PLAYER, AM);
    expect(list[0]!.author_display_name).toBe('');
    expect(list[0]!.author_auth_user_id).toBe('auth-departed-9');
  });
});
