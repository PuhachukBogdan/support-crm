import { Metadata } from '@grpc/grpc-js';
import { EXPORT_SCOPES } from '@crm/common';
import { AuthorityUnavailableError } from '../auth/auth.client';
import { UploadsUnavailableError } from '../uploads/uploads.client';
import { ExportForbiddenError, ExportService, UnknownScopeError } from './export.service';
import { QuotaExhaustedError } from './export.quota';
import { RowLimitExceededError } from './export.producer';
import type { ExportJobRow } from './export.repository';

/**
 * T022 / T028b (feature 017, US1) — the completion transaction, and the producer's AUTHORITY.
 *
 * The authority tests are the ones that matter most, because the gap they cover is the CRITICAL
 * `/speckit-analyze` found: the request and the production happen in different processes at different
 * times, and nothing in the original plan said where the producer's permissions come from. Unanswered,
 * the answer is "nothing is presented", `users` refuses every export, and it is only visible on a live
 * run — the exact shape of feature 016's wire defect.
 */
const SCOPE_KEY = EXPORT_SCOPES.conversations.permission;

const ROW: ExportJobRow = {
  id: 'exp-1',
  account_id: 'acc-1',
  scope: 'conversations',
  format: 'csv',
  requested_by: 'user-1',
  status: 'running',
  row_count: null,
  byte_size: null,
  upload_id: null,
  failure_reason: null,
  expires_at: new Date('2026-07-29T10:00:00.000Z'),
  created_at: new Date('2026-07-28T10:00:00.000Z'),
  completed_at: null,
};

function harness(over: Partial<Record<string, unknown>> = {}) {
  const failed: Array<{ id: string; reason: string }> = [];
  const transactions: unknown[][] = [];
  let transactionBoundCorrectly = false;

  const repo = {
    create: jest.fn(async (_a: string, i: Record<string, unknown>) => ({ ...ROW, ...i })),
    fail: jest.fn(async (_a: string, id: string, reason: string) => {
      failed.push({ id, reason });
      return true;
    }),
    completeStatement: jest.fn(() => ({ kind: 'complete' })),
    runInTransaction: jest.fn(async function (this: unknown, statements: unknown[]) {
      // The 013 defect, pinned: `$transaction` must be invoked as a METHOD. A fake that is a standalone
      // function never needs `this`, which is exactly why the real code broke and no unit test noticed.
      transactionBoundCorrectly = this !== undefined;
      transactions.push(statements);
    }),
    countInWindow: jest.fn(async () => 0),
    ...(over.repo as object),
  };

  const producer = {
    produce: jest.fn(async () => ({ rowCount: 3, byteSize: 120 })),
    ...(over.producer as object),
  };
  const quota = { assertWithinQuota: jest.fn(async () => undefined), ...(over.quota as object) };
  const uploads = {
    createUpload: jest.fn(async () => ({
      uploadId: 'up-1',
      byteSize: 120,
      displayName: 'conversations-2026-07-28.csv',
    })),
    ...(over.uploads as object),
  };
  const authority = {
    resolve: jest.fn(async () => ({ roleKey: 'teamlead', permissionKeys: [SCOPE_KEY] })),
    ...(over.authority as object),
  };
  const audit = { statement: jest.fn(() => ({ kind: 'audit' })), ...(over.audit as object) };

  const service = new ExportService(
    repo as never,
    producer as never,
    quota as never,
    uploads as never,
    authority as never,
    audit as never,
  );
  return {
    service,
    repo,
    producer,
    quota,
    uploads,
    authority,
    audit,
    failed,
    transactions,
    get transactionBoundCorrectly() {
      return transactionBoundCorrectly;
    },
  };
}

describe('create — refuses having written nothing (FR-005/FR-009/FR-017)', () => {
  const args = {
    accountId: 'acc-1',
    requestedBy: 'user-1',
    permissions: [SCOPE_KEY],
    scopeName: 'conversations',
    filters: {},
    rawFilters: {},
  };

  it('an unknown scope is refused and no row is created', async () => {
    const h = harness();
    await expect(
      h.service.create({ ...args, scopeName: 'nonsense' }, new Date()),
    ).rejects.toBeInstanceOf(UnknownScopeError);
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('the SERVICE tier checks the permission independently of the gateway', async () => {
    const h = harness();
    await expect(
      h.service.create({ ...args, permissions: ['crm.inbox.view'] }, new Date()),
    ).rejects.toBeInstanceOf(ExportForbiddenError);
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('an exhausted quota refuses BEFORE the insert — no job queued', async () => {
    const h = harness({
      quota: {
        assertWithinQuota: jest.fn(async () => {
          throw new QuotaExhaustedError(3600);
        }),
      },
    });
    await expect(h.service.create(args, new Date())).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('the expiry is computed from the scope TTL, not from a constant in code', async () => {
    const h = harness();
    const now = new Date('2026-07-28T10:00:00.000Z');
    await h.service.create(args, now);
    const createCall = h.repo.create.mock.calls[0] as unknown as [string, { expiresAt: Date }];
    const passed = createCall[1];
    expect(passed.expiresAt.getTime() - now.getTime()).toBe(
      EXPORT_SCOPES.conversations.ttlSeconds * 1000,
    );
  });
});

describe('*** run — the producer acts with RE-RESOLVED authority (FR-028 / research R15) ***', () => {
  it('resolves the requester CURRENT permissions and presents them to the store call', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());

    expect(h.authority.resolve).toHaveBeenCalledWith('acc-1', 'user-1');
    const md = (h.uploads.createUpload.mock.calls[0] as unknown as unknown[])[4] as Metadata;
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-user-id')[0]).toBe('user-1');
    expect(md.get('x-actor-permissions')[0]).toBe(SCOPE_KEY);
  });

  it('*** never calls the store with an EMPTY permission set *** (016 wire defect)', async () => {
    // The defect this pins: `users` reads `x-actor-permissions` from metadata and the export purpose
    // declares a permission, so an empty value means every export is correctly refused — both tiers
    // right, the wire between them wrong, and invisible until a live run.
    const h = harness();
    await h.service.run(ROW, new Date());
    const md = (h.uploads.createUpload.mock.calls[0] as unknown as unknown[])[4] as Metadata;
    expect(String(md.get('x-actor-permissions')[0] ?? '')).not.toBe('');
  });

  it('a permission REVOKED between request and production fails the export, with nothing stored', async () => {
    const h = harness({
      authority: { resolve: jest.fn(async () => ({ roleKey: 'agent', permissionKeys: [] })) },
    });
    const outcome = await h.service.run(ROW, new Date());

    expect(outcome).toBe('failed');
    expect(h.failed).toEqual([{ id: 'exp-1', reason: 'authority_revoked' }]);
    expect(h.uploads.createUpload).not.toHaveBeenCalled();
    expect(h.producer.produce).not.toHaveBeenCalled();
    expect(h.transactions).toHaveLength(0); // and therefore NO audit entry
  });

  it('authority that cannot be ESTABLISHED also refuses — it never proceeds on an assumption', async () => {
    const h = harness({
      authority: {
        resolve: jest.fn(async () => {
          throw new AuthorityUnavailableError('rpc failed');
        }),
      },
    });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    expect(h.uploads.createUpload).not.toHaveBeenCalled();
  });

  it('no permission set is ever written to the export record', async () => {
    // Caching the requester's permissions on the row would reintroduce the stale-authority window that
    // feature 014 deliberately refused for automation authors.
    const h = harness();
    await h.service.create(
      {
        accountId: 'acc-1',
        requestedBy: 'user-1',
        permissions: [SCOPE_KEY],
        scopeName: 'conversations',
        filters: {},
        rawFilters: {},
      },
      new Date(),
    );
    const written = JSON.stringify(
      (h.repo.create.mock.calls[0] as unknown as [string, unknown])[1],
    );
    expect(written).not.toContain(SCOPE_KEY);
  });
});

describe('run — completion is ONE transaction with its audit entry (FR-018/FR-020)', () => {
  it('marks ready and writes export.create in a single transaction', async () => {
    const h = harness();
    expect(await h.service.run(ROW, new Date())).toBe('completed');

    expect(h.transactions).toHaveLength(1);
    expect(h.transactions[0]).toHaveLength(2); // the row transition AND the entry
    expect(h.repo.completeStatement).toHaveBeenCalled();
    expect(h.audit.statement).toHaveBeenCalled();
  });

  it('*** $transaction is invoked as a METHOD *** (feature 013 live defect)', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());
    expect(h.transactionBoundCorrectly).toBe(true);
  });

  it('the audit detail carries ONLY format / rowCount / scope', async () => {
    const h = harness();
    await h.service.run(ROW, new Date());
    const call = h.audit.statement.mock.calls[0] as unknown as [string, { detail: Record<string, unknown> }];
    const entry = call[1];
    expect(Object.keys(entry.detail).sort()).toEqual(['format', 'rowCount', 'scope']);
    // No filter value, no filename, no row value — the allow-list makes them inexpressible, and this
    // asserts the writer does not even try.
    expect(JSON.stringify(entry.detail)).not.toContain('.csv');
  });

  it('a failing transaction leaves the export NOT ready — refused rather than unaudited', async () => {
    const h = harness({
      repo: {
        runInTransaction: jest.fn(async () => {
          throw new Error('audit write failed');
        }),
      },
    });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    expect(h.failed).toHaveLength(1);
  });
});

describe('run — failure reasons are CODES from the closed list', () => {
  it('a row-limit refusal fails with row_limit_exceeded and stores nothing', async () => {
    const h = harness({
      producer: {
        produce: jest.fn(async () => {
          throw new RowLimitExceededError();
        }),
      },
    });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    expect(h.failed).toEqual([{ id: 'exp-1', reason: 'row_limit_exceeded' }]);
    expect(h.uploads.createUpload).not.toHaveBeenCalled();
  });

  it('storage being unavailable fails with storage_unavailable and no audit entry', async () => {
    const h = harness({
      uploads: {
        createUpload: jest.fn(async () => {
          throw new UploadsUnavailableError('down');
        }),
      },
    });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    expect(h.failed).toEqual([{ id: 'exp-1', reason: 'storage_unavailable' }]);
    expect(h.transactions).toHaveLength(0);
  });

  it('a refusal from users (a gRPC status) is also a storage failure — nothing landed', async () => {
    const h = harness({
      uploads: {
        createUpload: jest.fn(async () => {
          throw { code: 7, message: 'forbidden' };
        }),
      },
    });
    expect(await h.service.run(ROW, new Date())).toBe('failed');
    expect(h.failed[0]!.reason).toBe('storage_unavailable');
  });
});
