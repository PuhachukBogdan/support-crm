import { AssignmentService } from './assignment.service';
import type { AssignmentRepository, AssignmentRow, PlayerRef } from './assignment.repository';
import type { PlayerRepository } from '../player/player.repository';
import type { OperatorRepository } from '../operator/operator.repository';

/**
 * T011–T014 (feature 026, roadmap 5.7) — attach, detach, and the audit that is their PRICE.
 *
 * ── Why one file ────────────────────────────────────────────────────────────────────────────────
 * The four requirements here are relationships between the same three moving parts (the attachment,
 * the audit entry, the refusal): *"a real change writes one entry and a no-op writes none"* is not a
 * fact about either half alone. One fake store, so the halves cannot disagree about what "already
 * attached" means.
 *
 * ⚠️ The fake's `activeFor` returns a COPY. Prisma hands back a fresh row per query, and a fake that
 * returned a live reference would let a later write retroactively change what the caller had already
 * read — the mistake feature 025's first draft made, which reported a product defect that did not
 * exist.
 */

const PLAYER: PlayerRef = { brandId: 'brand-a', playerId: 'ply-1' };

function makeStore(rows: AssignmentRow[] = [], managers = ['am-1', 'am-2'], playerExists = true) {
  const audits: Array<Record<string, unknown>> = [];
  let seq = rows.length;

  const repo = {
    async activeFor(_a: string, p: PlayerRef) {
      const found = rows.find(
        (r) => r.brand_id === p.brandId && r.player_id === p.playerId && r.ended_at === null,
      );
      return found ? { ...found } : null;
    },
    async attach(
      accountId: string,
      input: { player: PlayerRef; amAuthUserId: string; assignedBy: string },
      record: (tx: unknown) => unknown,
    ) {
      seq += 1;
      const row: AssignmentRow = {
        id: `as-${seq}`,
        brand_id: input.player.brandId,
        player_id: input.player.playerId,
        am_auth_user_id: input.amAuthUserId,
        assigned_by: input.assignedBy,
        started_at: new Date('2026-08-02T10:00:00Z'),
        ended_at: null,
        ended_by: null,
      };
      rows.push(row);
      await record(txWith(audits));
      return row;
    },
    async detach(_a: string, id: string, endedBy: string, record: (tx: unknown) => unknown) {
      const row = rows.find((r) => r.id === id)!;
      row.ended_at = new Date('2026-08-02T12:00:00Z');
      row.ended_by = endedBy;
      await record(txWith(audits));
    },
  } as unknown as AssignmentRepository;

  const players = {
    async getPlayer() {
      return playerExists ? { player_id: PLAYER.playerId } : null;
    },
  } as unknown as PlayerRepository;

  const operators = {
    async resolveByAuthUserIds(_a: string, ids: readonly string[]) {
      // Mirrors the real repository: ACTIVE profiles only, and an unknown identity is simply absent.
      return ids
        .filter((i) => managers.includes(i))
        .map((i) => ({ operatorId: `op-${i}`, authUserId: i }));
    },
  } as unknown as OperatorRepository;

  return { service: new AssignmentService(repo, players, operators), rows, audits };
}

const txWith = (audits: Array<Record<string, unknown>>) => ({
  auditEntry: {
    create: async (a: Record<string, unknown>) => {
      audits.push(a);
    },
  },
});

describe('⭐ exactly one audit entry per real change, and none for a no-op (FR-015)', () => {
  it('a real attach writes EXACTLY one entry', async () => {
    const { service, audits, rows } = makeStore();
    const out = await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    expect(out.status).toBe('ok');
    expect(rows).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({ action: 'player.assign', actor_user_id: 'lead-1' });
  });

  it('⭐ attaching the SAME manager again writes ZERO entries', async () => {
    // A no-op that recorded would inflate the abnormal-volume signal at its source — and that signal
    // is the entire control on self-assignment.
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    const out = await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    expect(out.status).toBe('unchanged');
    expect(audits).toHaveLength(1);
  });

  it('a detach writes exactly one entry, naming the caller who did it', async () => {
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    const out = await service.unassign('acc-1', PLAYER, 'lead-2');
    expect(out.status).toBe('ok');
    expect(audits).toHaveLength(2);
    expect(audits[1]!.data).toMatchObject({ action: 'player.unassign', actor_user_id: 'lead-2' });
  });

  it('detaching a player nobody holds writes nothing and is not an error', async () => {
    const { service, audits } = makeStore();
    const out = await service.unassign('acc-1', PLAYER, 'lead-1');
    expect(out.status).toBe('unchanged');
    expect(audits).toHaveLength(0);
  });
});

describe('the audit entry answers "who attached whom, and was it themselves?"', () => {
  it('⭐ records the ACTOR and the MANAGER separately', async () => {
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    const data = audits[0]!.data as Record<string, unknown>;
    expect(data.actor_user_id).toBe('lead-1');
    expect((data.detail_json as Record<string, unknown>).managerRef).toBe('am-1');
    expect((data.detail_json as Record<string, unknown>).selfAssigned).toBe('false');
  });

  it('⭐ marks a SELF-assignment as such — the harvesting pattern the trail exists to see', async () => {
    // "Who attached a hundred players TO THEMSELVES this hour?" is the question, and `selfAssigned`
    // is the key feature 015 reserved for it long before this feature existed.
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, '', 'am-1'); // empty manager ⇒ myself
    const data = audits[0]!.data as Record<string, unknown>;
    expect((data.detail_json as Record<string, unknown>).selfAssigned).toBe('true');
    expect((data.detail_json as Record<string, unknown>).managerRef).toBe('am-1');
  });

  it('names the PLAYER by its full identity, and carries no free text', async () => {
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    const data = audits[0]!.data as Record<string, unknown>;
    // A bare platform id names two people (feature 020), so the target carries the brand too.
    expect(data.target_ref).toBe('brand-a:ply-1');
    expect(Object.keys(data.detail_json as object).sort()).toEqual(['managerRef', 'selfAssigned']);
  });
});

describe('the four refusals are four different answers', () => {
  it('⭐ a player already attached to SOMEBODY ELSE is refused, never silently replaced', async () => {
    // The 🅿 one-active-manager constraint is only visible if breaking it says so. A caller who means
    // to move the player unassigns first — deliberately, as two audited acts.
    const { service, audits, rows } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    const out = await service.assign('acc-1', PLAYER, 'am-2', 'lead-1');
    expect(out.status).toBe('already_assigned');
    expect(rows.filter((r) => r.ended_at === null)).toHaveLength(1);
    expect(rows[0]!.am_auth_user_id).toBe('am-1'); // untouched
    expect(audits).toHaveLength(1);
  });

  it('a manager with no ACTIVE operator profile is refused, distinctly', async () => {
    // An attachment to somebody who has left would be a portfolio nobody is looking after while the
    // record claims otherwise (FR-005).
    const { service, audits } = makeStore([], ['am-1']);
    const out = await service.assign('acc-1', PLAYER, 'departed', 'lead-1');
    expect(out.status).toBe('no_such_manager');
    expect(audits).toHaveLength(0);
  });

  it('a player that does not exist — or is another account’s — is refused as NOT FOUND', async () => {
    // The read goes through the account-scoped client, so "not yours" and "does not exist" are the
    // same query result. A caller learns nothing about other tenants either way.
    const { service, audits } = makeStore([], ['am-1'], false);
    const out = await service.assign('acc-1', PLAYER, 'am-1', 'lead-1');
    expect(out.status).toBe('no_such_player');
    expect(audits).toHaveLength(0);
  });

  it('the player check comes FIRST, so a probe learns nothing about managers', async () => {
    // Both wrong: if the manager were checked first, a caller could enumerate staff by watching which
    // error came back for a player id they had guessed.
    const { service } = makeStore([], ['am-1'], false);
    const out = await service.assign('acc-1', PLAYER, 'nobody-at-all', 'lead-1');
    expect(out.status).toBe('no_such_player');
  });
});
