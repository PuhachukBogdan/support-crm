import { Logger } from '@nestjs/common';
import { errorLabel } from './error-label';
import { ExportService } from './export.service';
import { RowLimitExceededError } from './export.producer';
import type { ExportJobRow } from './export.repository';

/**
 * T055 (feature 017, polish) — **no filter value, filename or row value reaches a log line**
 * (SEC-26 / Principle IV / FR-019), on the failure paths above all.
 *
 * ── Why this feature is the hard case ────────────────────────────────────────────────────────────
 * Every feature since 010 has had a no-PII-in-logs test. This one has a shape the others did not: the
 * producer runs a FILTERED query whose filter values are the sensitive part, and a failure inside that
 * query produces an error object created by somebody else. Feature 014's live lesson said "log the
 * message, not just the class", and applying that unchanged here means a Prisma error echoing the query
 * arguments — the filters — into a log line, on precisely the path an operator then reads.
 *
 * So the tests are behavioural: a real service, a real failure, the logger captured, and the assertion
 * is that the PII-shaped fixture values are absent from what was written. A structural scan would not
 * catch it, because the offending code (`err.message`) looks correct.
 */
const PLAYER = 'ply-4711-alice-smith';
const BRAND = 'brand-secret-casino';

const ROW: ExportJobRow & { filters_json: Record<string, unknown> } = {
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
  // The PII-shaped fixture. These values are what must never appear in a log line.
  filters_json: { playerId: PLAYER, brandIn: [BRAND] },
};

function harness(produce: () => Promise<never>) {
  const repo = {
    fail: jest.fn(async () => true),
    completeStatement: jest.fn(() => ({})),
    runInTransaction: jest.fn(async () => undefined),
  };
  const service = new ExportService(
    repo as never,
    { produce: jest.fn(produce) } as never,
    { assertWithinQuota: jest.fn(async () => undefined) } as never,
    { createUpload: jest.fn(async () => ({ uploadId: 'up-1' })) } as never,
    {
      resolve: jest.fn(async () => ({
        roleKey: 'teamlead',
        permissionKeys: ['crm.exports.conversations'],
      })),
    } as never,
    { statement: jest.fn(() => ({})) } as never,
  );
  return service;
}

function captureLogs(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  const consoleSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return {
    lines,
    restore: () => {
      for (const s of spies) s.mockRestore();
      consoleSpy.mockRestore();
    },
  };
}

describe('*** a failure inside the filtered read logs NO filter value ***', () => {
  it('a Prisma-shaped error echoing its query arguments is reduced to its class name', async () => {
    // This is the real shape: Prisma's `PrismaClientValidationError` and driver errors both put the
    // query arguments in `message`. Simulated faithfully rather than hypothetically.
    const prismaish = Object.assign(new Error(`Invalid \`prisma.conversation.findMany()\` invocation:

{
  where: {
    player_id: "${PLAYER}",
    brand_id: { in: ["${BRAND}"] }
  }
}`), { name: 'PrismaClientValidationError' });

    const cap = captureLogs();
    const service = harness(async () => {
      throw prismaish;
    });
    await service.run(ROW, new Date());
    cap.restore();

    const all = cap.lines.join('\n');
    expect(all).toContain('exp-1'); // the export id IS logged — a uuid, and what makes the line useful
    expect(all).toContain('PrismaClientValidationError'); // the class, for diagnosability
    // …and nothing else from that error.
    expect(all).not.toContain(PLAYER);
    expect(all).not.toContain(BRAND);
    expect(all).not.toContain('player_id');
    expect(all).not.toContain('where');
  });

  it('OUR OWN error classes keep their messages — 014’s lesson is not discarded', async () => {
    const cap = captureLogs();
    const service = harness(async () => {
      throw new RowLimitExceededError();
    });
    await service.run(ROW, new Date());
    cap.restore();

    // A cap refusal must say what cap. Its message is a fixed string we wrote, so there is nothing in
    // it that could be tenant data.
    expect(cap.lines.join('\n')).toMatch(/RowLimitExceededError: row limit exceeded/);
  });

  it('a thrown gRPC status contributes its CODE, never its message', () => {
    // A status object's `message`/`details` are whatever the peer put there. The code is ours to report.
    expect(errorLabel({ code: 7, message: `forbidden for ${PLAYER}` })).toBe('rpc(7)');
    expect(errorLabel({ code: 7, message: PLAYER })).not.toContain(PLAYER);
  });

  it('an unknown non-Error throw degrades to a constant', () => {
    expect(errorLabel('a string with ' + PLAYER)).toBe('error');
    expect(errorLabel(undefined)).toBe('error');
    expect(errorLabel({ detail: PLAYER })).toBe('error');
  });
});

describe('*** nothing on the export path logs a filename or a produced row ***', () => {
  it('the completion path logs nothing at all', async () => {
    const cap = captureLogs();
    const service = new ExportService(
      {
        completeStatement: jest.fn(() => ({})),
        runInTransaction: jest.fn(async () => undefined),
        fail: jest.fn(),
      } as never,
      { produce: jest.fn(async () => ({ rowCount: 3, byteSize: 100 })) } as never,
      { assertWithinQuota: jest.fn() } as never,
      {
        createUpload: jest.fn(async () => ({ uploadId: 'up-1' })),
      } as never,
      {
        resolve: jest.fn(async () => ({
          roleKey: 'teamlead',
          permissionKeys: ['crm.exports.conversations'],
        })),
      } as never,
      { statement: jest.fn(() => ({})) } as never,
    );
    expect(await service.run(ROW, new Date())).toBe('completed');
    cap.restore();

    // A successful export is ordinary work. The AUDIT entry is the record of it; a log line would be a
    // second, unregulated copy of the same fact with none of the allow-list protections.
    expect(cap.lines).toEqual([]);
  });

  it('the filename is never logged, on any path', async () => {
    const cap = captureLogs();
    const service = harness(async () => {
      throw new RowLimitExceededError();
    });
    await service.run(ROW, new Date());
    cap.restore();

    // `conversations-2026-07-28.csv` carries no filter value today, and it is still not logged: a
    // filename travels with the file and echoes into browser and mail-client history (SEC-26).
    expect(cap.lines.join('\n')).not.toContain('.csv');
  });

  it('the error-label allow-list is a closed list of OUR classes', () => {
    // Asserted as a property of the labels, not by reading the array: a third-party class must not be
    // able to arrive on the list by resembling one of ours.
    const foreign = Object.assign(new Error(PLAYER), { name: 'SomeVendorError' });
    expect(errorLabel(foreign)).toBe('SomeVendorError');
    expect(errorLabel(new Error(PLAYER))).toBe('Error');
  });
});
