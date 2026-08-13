import { Metadata } from '@grpc/grpc-js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { ExportController } from './export.grpc.controller';
import type { ExportJobRow } from './export.repository';
import { fakeStatusRepository } from '../status/status.fixture';

/**
 * T043 / T052 (feature 017, US3) — **four different situations, one answer** (FR-011 / SC-006).
 *
 * The property under test is that an unknown id, another account's id, a same-account non-owner's id and
 * an EXPIRED export are indistinguishable to a caller. Not "all of them are refused" — refusals are
 * easy — but *refused identically*, because any difference between them is an existence oracle: a
 * `403 forbidden` where an unknown id gives `404` tells the asker that the id is real and belongs to a
 * colleague. Over a few hundred guesses that is a map of who exports what.
 *
 * ── Why this is tested through the CONTROLLER ────────────────────────────────────────────────────
 * The owner predicate lives in the repository (`getOwned` takes `requestedBy`), so a repository test can
 * only assert that the argument is passed. The thing that could go wrong is at this layer: a handler
 * that branches on why the row is missing, or one that reads a row without the owner predicate. Both are
 * visible here and invisible one layer down.
 */
const ACCOUNT = 'acc-1';
const OWNER = 'user-1';

const READY: ExportJobRow = {
  id: 'exp-1',
  account_id: ACCOUNT,
  scope: 'conversations',
  format: 'csv',
  requested_by: OWNER,
  status: 'ready',
  row_count: 10,
  byte_size: 500,
  upload_id: 'up-1',
  failure_reason: null,
  expires_at: new Date(Date.now() + 3_600_000),
  created_at: new Date('2026-07-28T10:00:00.000Z'),
  completed_at: new Date('2026-07-28T10:00:05.000Z'),
};

function md(accountId = ACCOUNT, userId = OWNER): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-permissions', 'crm.exports.conversations');
  return m;
}

/**
 * A repository fake that behaves like the real owner-scoped query: it returns a row ONLY when both the
 * account and the requester match. That is what makes the assertions below meaningful — the fake cannot
 * hand the controller a cross-account row to leak, exactly as `forAccount` cannot.
 */
function controller(rows: ExportJobRow[] = [READY]) {
  const calls: Array<[string, string, string]> = [];
  const repo = {
    getOwned: jest.fn(async (accountId: string, id: string, requestedBy: string) => {
      calls.push([accountId, id, requestedBy]);
      return (
        rows.find(
          (r) => r.account_id === accountId && r.id === id && r.requested_by === requestedBy,
        ) ?? null
      );
    }),
    listOwn: jest.fn(async () => ({ rows, nextCursor: null })),
  };
  const service = { create: jest.fn(), run: jest.fn() };
  const maintenance = { runDueExports: jest.fn(), expireDueExports: jest.fn() };
  return {
    ctl: new ExportController(
      service as never,
      repo as never,
      maintenance as never,
      fakeStatusRepository(),
    ),
    repo,
    calls,
    maintenance,
  };
}

const codeOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as RpcException).getError?.() &&
      typeof ((err as RpcException).getError() as { code?: number }).code === 'number'
      ? ((err as RpcException).getError() as { code: number }).code
      : undefined;
  }
};

const messageOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return ((err as RpcException).getError() as { message?: string })?.message;
  }
};

describe('*** GetExport: the four situations are byte-identical ***', () => {
  it('the owner sees their own export', async () => {
    const h = controller();
    const res = await h.ctl.getExport({ exportId: 'exp-1' }, md());
    expect(res.id).toBe('exp-1');
  });

  it.each([
    ['an unknown id', 'exp-nope', ACCOUNT, OWNER],
    ['a same-account NON-OWNER', 'exp-1', ACCOUNT, 'user-2'],
    ['another account entirely', 'exp-1', 'acc-2', OWNER],
    ['an empty id', '', ACCOUNT, OWNER],
  ])('%s gets the same NOT_FOUND', async (_label, id, account, user) => {
    const h = controller();
    const p = h.ctl.getExport({ exportId: id }, md(account, user));
    expect(await codeOf(p)).toBe(GrpcStatus.NOT_FOUND);
    // The MESSAGE too. A different string per case is the same oracle in a different field, and error
    // strings reach clients.
    expect(await messageOf(h.ctl.getExport({ exportId: id }, md(account, user)))).toBe('not found');
  });

  it('the owner predicate is always part of the query — never a post-read comparison', async () => {
    const h = controller();
    await h.ctl.getExport({ exportId: 'exp-1' }, md());
    // Both the account AND the requester go into the read. A handler that fetched by id and then
    // compared `row.requested_by` would have the row in hand, which is one edit away from returning it.
    expect(h.calls[0]).toEqual([ACCOUNT, 'exp-1', OWNER]);
  });

  it('a missing account context is refused before any read (Principle I)', async () => {
    const h = controller();
    const bare = new Metadata();
    bare.set('x-actor-user-id', OWNER);
    expect(await codeOf(h.ctl.getExport({ exportId: 'exp-1' }, bare))).toBe(
      GrpcStatus.PERMISSION_DENIED,
    );
    expect(h.repo.getOwned).not.toHaveBeenCalled();
  });
});

describe('*** ResolveExportArtefact: expiry is the SAME answer as never existed ***', () => {
  it('a ready, unexpired export resolves to an upload ID — never a URL', async () => {
    const h = controller();
    const ref = await h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md());
    expect(ref.uploadId).toBe('up-1');
    // An id, not a link. The bytes are fetched through the brokered read, which re-authorizes (FR-010).
    expect(JSON.stringify(ref)).not.toMatch(/https?:|X-Amz-|Signature|token/i);
  });

  it('a swept EXPIRED export is NOT_FOUND, not GONE', async () => {
    const h = controller([{ ...READY, status: 'expired', upload_id: null }]);
    const p = h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md());
    // 410/GONE would confirm that something existed here — an existence oracle for an object that is
    // deliberately unrecoverable.
    expect(await codeOf(p)).toBe(GrpcStatus.NOT_FOUND);
  });

  it('*** past the window but NOT YET SWEPT is also NOT_FOUND ***', async () => {
    // The load-bearing case. Both expiries are driven by ticks, so there is always an interval where the
    // record still says `ready`. If the refusal depended on the sweep having run, the security property
    // would depend on a scheduler's punctuality — which is not a security property at all.
    const h = controller([{ ...READY, expires_at: new Date(Date.now() - 1_000) }]);
    expect(await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe(
      GrpcStatus.NOT_FOUND,
    );
  });

  it('a ready row whose artefact reference was cleared is NOT_FOUND', async () => {
    // What the sweep leaves behind if it clears `upload_id` before the status write is observed. A null
    // reference must never become a request for upload id `""`.
    const h = controller([{ ...READY, upload_id: null }]);
    expect(await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe(
      GrpcStatus.NOT_FOUND,
    );
  });

  it('a non-owner cannot resolve an artefact either', async () => {
    const h = controller();
    expect(
      await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md(ACCOUNT, 'user-2'))),
    ).toBe(GrpcStatus.NOT_FOUND);
  });

  it('a still-running export is FAILED_PRECONDITION — a distinction only its OWNER can see', async () => {
    // Not an oracle: the caller already proved ownership to get here, and "not ready yet" is the answer
    // they are polling for. Telling a stranger this would be the leak; telling the owner is the feature.
    //
    // This test is the reason the handler checks expiry BEFORE readiness. With the checks the other way
    // round, every non-`ready` row (all of which have a null `upload_id`) fell into `not found` and this
    // branch was dead code that answered a waiting owner with "your export is lost".
    const h = controller([{ ...READY, status: 'running', upload_id: null }]);
    expect(await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe(
      GrpcStatus.FAILED_PRECONDITION,
    );
    expect(await messageOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe('running');
  });

  it('a FAILED export is NOT_FOUND — there is no artefact and never will be (FR-015)', async () => {
    // Track B corrected this: a failed export had been reported as FAILED_PRECONDITION, which the edge
    // maps to `400 invalid request` — blaming the caller for a request that was fine. `failed` is
    // terminal, so "there is nothing here" is the true answer; the REASON lives on `GET /exports/:id`,
    // where the owner can act on it.
    const h = controller([
      { ...READY, status: 'failed', upload_id: null, failure_reason: 'row_limit_exceeded' },
    ]);
    expect(await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe(
      GrpcStatus.NOT_FOUND,
    );
  });

  it('an EXPIRED export that still carries a status is not distinguishable by it', async () => {
    // Expiry wins over every other branch. A row that expired while `running` must not report `running`
    // to a caller — the ordering guarantees "gone" outranks "in progress".
    const h = controller([
      { ...READY, status: 'running', upload_id: null, expires_at: new Date(Date.now() - 1) },
    ]);
    expect(await codeOf(h.ctl.resolveExportArtefact({ exportId: 'exp-1' }, md()))).toBe(
      GrpcStatus.NOT_FOUND,
    );
  });
});

describe('*** the maintenance RPCs refuse a user session ***', () => {
  it.each([
    ['RunDueExports', (c: ExportController, m: Metadata) => c.runDueExports({ limit: 5 }, m)],
    ['ExpireDueExports', (c: ExportController, m: Metadata) => c.expireDueExports({ limit: 5 }, m)],
  ])('%s requires x-actor-kind: system', async (_name, call) => {
    const h = controller();
    // A user session must never reach a cross-account path, even a counts-only one (014's rule).
    expect(await codeOf(call(h.ctl, md()))).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(h.maintenance.runDueExports).not.toHaveBeenCalled();
    expect(h.maintenance.expireDueExports).not.toHaveBeenCalled();
  });

  it('a system actor is accepted, and no permission key is consulted', async () => {
    const h = controller();
    h.maintenance.expireDueExports = jest.fn(async () => ({ expired: 3 }));
    const ctl = new ExportController(
      { create: jest.fn() } as never,
      h.repo as never,
      h.maintenance as never,
      fakeStatusRepository(),
    );
    const system = new Metadata();
    system.set('x-actor-kind', 'system');
    // No account, no user, no permissions — and it works. There is no permission that grants this, which
    // is why breadth of permissions cannot reach it.
    expect(await ctl.expireDueExports({ limit: 5 }, system)).toEqual({ expired: 3 });
  });
});
