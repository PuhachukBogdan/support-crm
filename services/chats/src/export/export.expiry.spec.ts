import {
  EXPORT_ARTEFACT_TTL_SECONDS,
  EXPORT_SCOPES,
  UPLOAD_PURPOSES,
} from '@crm/common';
import { ExportMaintenance } from './export.maintenance';
import { ExportService } from './export.service';

/**
 * T041 (feature 017, US3) — **the two expiries are one decision** (FR-012/FR-026, research R7).
 *
 * The export record's `expires_at` lives in `chats_db`; the artefact's lives in `users_db`. They cannot
 * be the same column (one database per service, Principle VIII) and they must never disagree, because a
 * record that says `ready` while the bytes are gone is a broken download, and bytes that outlive the
 * record are the SEC-27 leak this feature exists to close.
 *
 * They agree because both are DERIVED from one exported constant. That is the whole mechanism, and this
 * file asserts it directly rather than testing two values that happen to match today — the first draft
 * derived the artefact's TTL from the purpose NAME with a `replace()`, which would have passed a
 * value-equality test while coupling two catalogues through string spelling.
 */
describe('*** both expiries come from ONE constant ***', () => {
  it('the export scope and the upload purpose read the same TTL', () => {
    expect(EXPORT_SCOPES.conversations.ttlSeconds).toBe(EXPORT_ARTEFACT_TTL_SECONDS);
    expect(UPLOAD_PURPOSES.conversation_export.ttlSeconds).toBe(EXPORT_ARTEFACT_TTL_SECONDS);
  });

  it('the value is 24 hours, as recorded in FR-026', () => {
    // Pinned so a change is a decision with a diff, not a drift. The reasoning (1 h pushes people to
    // re-export, 7 d makes the bucket a standing PII store while SEC-25 is open) lives on the constant.
    expect(EXPORT_ARTEFACT_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('the artefact is only deletable BECAUSE its purpose is ephemeral', () => {
    // A TTL on a non-ephemeral purpose would be a number nothing reads. The pairing is what makes the
    // purge legal, and `purposes.spec.ts` fails the build if an `ingested` purpose ever gains it.
    expect(UPLOAD_PURPOSES.conversation_export.ephemeral).toBe(true);
    expect(UPLOAD_PURPOSES.message_attachment.ephemeral).toBe(false);
    expect(UPLOAD_PURPOSES.avatar.ephemeral).toBe(false);
  });
});

describe('the record’s expiry is computed from the scope, at creation', () => {
  function harness() {
    const created: Array<{ expiresAt: Date }> = [];
    const repo = {
      create: jest.fn(async (_a: string, input: { expiresAt: Date }) => {
        created.push(input);
        return { id: 'exp-1', ...input };
      }),
    };
    const service = new ExportService(
      repo as never,
      { produce: jest.fn() } as never,
      { assertWithinQuota: jest.fn(async () => undefined) } as never,
      { createUpload: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      { statement: jest.fn() } as never,
    );
    return { service, created };
  }

  const args = {
    accountId: 'acc-1',
    requestedBy: 'user-1',
    permissions: [EXPORT_SCOPES.conversations.permission],
    scopeName: 'conversations',
    filters: {},
    rawFilters: {},
  };

  it('fixed at creation, not at download — a window that could be extended is not a window', async () => {
    const h = harness();
    const now = new Date('2026-07-28T09:00:00.000Z');
    await h.service.create(args, now);

    expect(h.created[0]!.expiresAt.toISOString()).toBe('2026-07-29T09:00:00.000Z');
  });

  it('the same request an hour later expires an hour later — the TTL is relative to the request', async () => {
    const h = harness();
    await h.service.create(args, new Date('2026-07-28T09:00:00.000Z'));
    await h.service.create(args, new Date('2026-07-28T10:00:00.000Z'));

    const delta = h.created[1]!.expiresAt.getTime() - h.created[0]!.expiresAt.getTime();
    expect(delta).toBe(60 * 60 * 1000);
  });
});

describe('*** ExpireDueExports is idempotent BY PREDICATE, not by bookkeeping *** (FR-014)', () => {
  /**
   * The sweep's second run must be a no-op, and the honest way to show that is a fake whose rows actually
   * change state: `markExpired` is conditional on `status: 'ready'`, so the row leaves the predicate the
   * moment it is swept. There is no "swept" flag to reconcile — the same reasoning as the conditional
   * claim on the run side, and the same reasoning feature 014 used for announce-once.
   */
  function sweeper(statuses: Record<string, string>) {
    const rows = { ...statuses };
    const repo = {
      findExpired: jest.fn(async (limit: number) =>
        Object.entries(rows)
          .filter(([, status]) => status === 'ready')
          .slice(0, limit)
          .map(([id]) => ({ id, account_id: 'acc-1' })),
      ),
      markExpired: jest.fn(async (_a: string, id: string) => {
        if (rows[id] !== 'ready') return false;
        rows[id] = 'expired';
        return true;
      }),
      findDue: jest.fn(async () => []),
    };
    return { m: new ExportMaintenance(repo as never, { run: jest.fn() } as never), repo, rows };
  }

  it('flips ready rows past their expiry and reports the count', async () => {
    const h = sweeper({ 'exp-1': 'ready', 'exp-2': 'ready', 'exp-3': 'failed' });
    expect(await h.m.expireDueExports(10, new Date())).toEqual({ expired: 2 });
    expect(h.rows).toEqual({ 'exp-1': 'expired', 'exp-2': 'expired', 'exp-3': 'failed' });
  });

  it('a re-run expires NOTHING a second time', async () => {
    const h = sweeper({ 'exp-1': 'ready' });
    await h.m.expireDueExports(10, new Date());
    expect(await h.m.expireDueExports(10, new Date())).toEqual({ expired: 0 });
  });

  it('a row a concurrent sweep already took is not double-counted', async () => {
    const h = sweeper({ 'exp-1': 'ready' });
    // `as never` at the assignment: a mock that ignores its arguments has a NARROWER type than the
    // property it replaces, which @swc/jest accepts and `tsc` rejects
    // (gotchas/swc-jest-no-typecheck, met again).
    h.repo.markExpired = jest.fn(async () => false) as never; // the other tick won
    const m = new ExportMaintenance(h.repo as never, { run: jest.fn() } as never);
    expect(await m.expireDueExports(10, new Date())).toEqual({ expired: 0 });
  });

  it('the batch cap is honoured — a large backlog is drained over ticks, not in one', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) many[`exp-${i}`] = 'ready';
    const h = sweeper(many);
    expect(await h.m.expireDueExports(10, new Date())).toEqual({ expired: 10 });
    expect(await h.m.expireDueExports(10, new Date())).toEqual({ expired: 10 });
  });

  it('a failed or already-expired export is never selected', async () => {
    const h = sweeper({ 'exp-1': 'failed', 'exp-2': 'expired', 'exp-3': 'queued' });
    expect(await h.m.expireDueExports(10, new Date())).toEqual({ expired: 0 });
    // A `queued` row has no artefact to expire; failing it is the runner's job, not the sweep's.
    expect(h.repo.markExpired).not.toHaveBeenCalled();
  });
});
