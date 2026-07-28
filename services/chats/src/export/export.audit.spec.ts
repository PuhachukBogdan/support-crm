import { EXPORT_SCOPES } from '@crm/common';
import { ExportMaintenance } from './export.maintenance';
import { ExportService } from './export.service';
import type { ExportJobRow } from './export.repository';

/**
 * T034 / T037 (feature 017, US2) — **exactly one audit entry per produced export, and none for an
 * export that was not produced** (FR-018 / FR-020).
 *
 * The interesting half is the second one. "One entry per export" is easy to get right on the happy
 * path and easy to get wrong on every other: a retried tick, a recovered stale claim, a failed audit
 * write. Feature 015's own Track B run recorded the shape to protect — *"no entry filed for a deletion
 * that never happened"* — and an export is the same claim with a wider payload, because these rows are
 * the record of who extracted customer data.
 *
 * ── Why "no duplicate on retry" is tested at the MAINTENANCE level ───────────────────────────────
 * `completeStatement` is conditional on `status: 'running'`, so a second attempt at an already-`ready`
 * row would move zero rows — but its transaction would still commit, and the audit entry inside it
 * would be written a SECOND time. That is not a hole, and this file says why rather than asserting a
 * check that does not exist: a completed export is `ready`, `findDue` selects only `queued` and STALE
 * `running`, and a stale `running` row is FAILED as `interrupted` rather than re-run. There is no
 * reachable path that runs a completed export twice, which is a stronger property than a de-dup guard
 * (a guard has to be remembered; an unreachable path does not).
 */
const SCOPE_KEY = EXPORT_SCOPES.conversations.permission;

const ROW: ExportJobRow = {
  id: 'exp-7',
  account_id: 'acc-1',
  scope: 'conversations',
  format: 'csv',
  requested_by: 'user-9',
  status: 'running',
  row_count: null,
  byte_size: null,
  upload_id: null,
  failure_reason: null,
  expires_at: new Date('2026-07-29T10:00:00.000Z'),
  created_at: new Date('2026-07-28T10:00:00.000Z'),
  completed_at: null,
};

interface AuditCall {
  accountId: string;
  entry: { action: string; actorUserId: string; targetRef: string; detail: Record<string, unknown> };
}

function harness(over: { produced?: { rowCount: number; byteSize: number }; transactionThrows?: boolean } = {}) {
  const auditCalls: AuditCall[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const completed: Array<Record<string, unknown>> = [];
  const committed: unknown[][] = [];

  const repo = {
    fail: jest.fn(async (_a: string, id: string, reason: string) => {
      failed.push({ id, reason });
      return true;
    }),
    completeStatement: jest.fn((_a: string, _id: string, input: Record<string, unknown>) => {
      completed.push(input);
      return { kind: 'complete', input };
    }),
    runInTransaction: jest.fn(async (statements: unknown[]) => {
      if (over.transactionThrows) throw new Error('audit write failed');
      committed.push(statements);
    }),
  };

  const producer = {
    produce: jest.fn(async () => over.produced ?? { rowCount: 42, byteSize: 4096 }),
  };
  const quota = { assertWithinQuota: jest.fn(async () => undefined) };
  const uploads = {
    createUpload: jest.fn(async () => ({
      uploadId: 'up-7',
      byteSize: 4096,
      displayName: 'conversations-2026-07-28.csv',
    })),
  };
  const authority = {
    resolve: jest.fn(async () => ({ roleKey: 'teamlead', permissionKeys: [SCOPE_KEY] })),
  };
  const audit = {
    statement: jest.fn((accountId: string, entry: AuditCall['entry']) => {
      auditCalls.push({ accountId, entry });
      return { kind: 'audit' };
    }),
  };

  const service = new ExportService(
    repo as never,
    producer as never,
    quota as never,
    uploads as never,
    authority as never,
    audit as never,
  );
  return { service, repo, audit, auditCalls, failed, completed, committed };
}

describe('*** one completed export ⇒ exactly ONE export.create entry *** (FR-018)', () => {
  it('one entry, not one per row', async () => {
    const h = harness({ produced: { rowCount: 25_000, byteSize: 900_000 } });
    expect(await h.service.run(ROW, new Date())).toBe('completed');

    // 25 000 rows, one entry. A per-row trail would be both useless and the largest PII surface in
    // the product.
    expect(h.auditCalls).toHaveLength(1);
    expect(h.auditCalls[0]!.entry.action).toBe('export.create');
  });

  it('the entry names the REQUESTER as the actor and the export as the target', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());
    const { accountId, entry } = h.auditCalls[0]!;

    expect(accountId).toBe('acc-1');
    // Not the worker, and not a system actor: the person whose authority produced the file is the
    // person accountable for it (FR-028). A system actor here would make the trail say "the CRM
    // exported 25 000 conversations", which answers nobody's question.
    expect(entry.actorUserId).toBe('user-9');
    expect(entry.targetRef).toBe('exp-7');
  });

  it('rowCount in the entry is the count of the file actually produced', async () => {
    const h = harness({ produced: { rowCount: 137, byteSize: 8_000 } });
    await h.service.run(ROW, new Date());

    // The producer's number, not the request's expectation — which is why 015 placed this entry at
    // COMPLETION rather than at request time (`rowCount` is unknowable before the file exists).
    expect(h.auditCalls[0]!.entry.detail.rowCount).toBe(137);
    expect(h.completed[0]!.rowCount).toBe(137);
  });

  it('the entry and the row transition are in the SAME transaction, in that order', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());

    expect(h.committed).toHaveLength(1);
    const statements = h.committed[0]! as Array<{ kind: string }>;
    expect(statements.map((s) => s.kind)).toEqual(['complete', 'audit']);
  });

  it('the detail carries the three allow-listed keys and nothing else', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());
    const detail = h.auditCalls[0]!.entry.detail;

    expect(Object.keys(detail).sort()).toEqual(['format', 'rowCount', 'scope']);
    expect(detail).toEqual({ format: 'csv', rowCount: 42, scope: 'conversations' });
  });
});

describe('*** an unwritable entry REFUSES the export *** (FR-020 — 015 strictness)', () => {
  it('the export is failed with a reason that says what actually happened', async () => {
    const h = harness({ transactionThrows: true });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    // `record_failed`, NOT `source_unavailable`: the artefact was produced and stored, and the export
    // was then refused because it could not be recorded. Borrowing the source code would send an
    // operator to the database for a problem in the trail — on the one failure that must be diagnosable.
    expect(h.failed).toEqual([{ id: 'exp-7', reason: 'record_failed' }]);
  });

  it('nothing downloadable survives — the row never gains its artefact reference', async () => {
    const h = harness({ transactionThrows: true });
    await h.service.run(ROW, new Date());

    // The completion statement was BUILT and then never committed, so `upload_id` is still null and
    // `ResolveExportArtefact` refuses. The bytes that were already stored are orphaned and are purged
    // by their own `expires_at` — wasted storage rather than an unaudited download (research R8).
    expect(h.repo.completeStatement).toHaveBeenCalled();
    expect(h.committed).toHaveLength(0);
  });
});

describe('*** an interrupted producer is never re-run, so it can never double-file ***', () => {
  function maintenance(due: Array<{ id: string; account_id: string; status: string }>) {
    const recovered: string[] = [];
    const repo = {
      findDue: jest.fn(async () => due),
      findExpired: jest.fn(async () => []),
      claim: jest.fn(async () => true),
      getOwnedForRun: jest.fn(async () => ROW),
      recoverStale: jest.fn(async (_a: string, id: string) => {
        recovered.push(id);
        return true;
      }),
    };
    const service = { run: jest.fn(async () => 'completed' as const) };
    return {
      m: new ExportMaintenance(repo as never, service as never),
      repo,
      service,
      recovered,
    };
  }

  it('a stale claim is FAILED as interrupted rather than produced again', async () => {
    const h = maintenance([{ id: 'exp-7', account_id: 'acc-1', status: 'running' }]);
    const res = await h.m.runDueExports(10, new Date(), 600_000);

    expect(h.recovered).toEqual(['exp-7']);
    // The load-bearing assertion: production is not attempted, so there is no second file, no second
    // store call and no second audit entry. A "retry the interrupted one" policy would need a de-dup
    // guard; refusing to retry needs nothing.
    expect(h.service.run).not.toHaveBeenCalled();
    expect(res).toEqual({ claimed: 0, completed: 0, failed: 0, recoveredStale: 1 });
  });

  it('a queued row is claimed once and produced once', async () => {
    const h = maintenance([{ id: 'exp-7', account_id: 'acc-1', status: 'queued' }]);
    await h.m.runDueExports(10, new Date(), 600_000);

    expect(h.repo.claim).toHaveBeenCalledTimes(1);
    expect(h.service.run).toHaveBeenCalledTimes(1);
  });

  it('a claim lost to a concurrent tick produces nothing', async () => {
    const h = maintenance([{ id: 'exp-7', account_id: 'acc-1', status: 'queued' }]);
    h.repo.claim = jest.fn(async () => false);
    const m = new ExportMaintenance(h.repo as never, h.service as never);

    const res = await m.runDueExports(10, new Date(), 600_000);
    // Two overlapping ticks, one winner. The loser writes nothing at all — no entry, no bytes.
    expect(h.service.run).not.toHaveBeenCalled();
    expect(res.claimed).toBe(0);
  });
});
