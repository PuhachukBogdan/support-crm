import { Queue, Worker } from 'bullmq';
import { SLA_SWEEP_JOB, SLA_SWEEP_QUEUE, SlaSweepJob } from './sla-sweep.job';
import type { RedisService } from '../queue/redis.service';
import type { ChatsMaintenanceClient } from '../chats/chats.client';

jest.mock('bullmq');

/**
 * T035 (feature 014, US2) — the worker's first real job. FAILS before it exists, PASSES after.
 *
 * BullMQ itself is mocked: what needs proving here is not that a queue library works, but that the
 * *scheduling contract* is right, because getting it wrong fails silently. A breach is the one event
 * nobody is waiting for — if this job never registers, or registers twice, or dies on the first error,
 * no request 500s and no user complains. The SLA simply stops working.
 *
 * So: registered exactly once, with a stable job id (idempotent across restarts and replicas), the
 * configured interval, a system-marked RPC call, and non-fatal failure handling.
 */
const QueueMock = Queue as unknown as jest.Mock;
const WorkerMock = Worker as unknown as jest.Mock;

function build(env: Record<string, string | undefined> = {}) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const add = jest.fn().mockResolvedValue({});
  const close = jest.fn().mockResolvedValue(undefined);
  QueueMock.mockImplementation(() => ({ add, close }));

  const handlers: Record<string, (...a: unknown[]) => void> = {};
  let processor: ((job: unknown) => Promise<void>) | undefined;
  WorkerMock.mockImplementation((_q: string, p: (job: unknown) => Promise<void>) => {
    processor = p;
    return {
      on: (event: string, cb: (...a: unknown[]) => void) => {
        handlers[event] = cb;
      },
      close,
    };
  });

  const sweepFirstReplySla = jest
    .fn()
    .mockResolvedValue({ checked: 3, breached: 1, rulesApplied: 2 });
  const job = new SlaSweepJob(
    { client: {} } as unknown as RedisService,
    { sweepFirstReplySla } as unknown as ChatsMaintenanceClient,
  );
  return { job, add, close, sweepFirstReplySla, handlers: () => handlers, runProcessor: () => processor!({}) };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SLA_SWEEP_INTERVAL_MS;
  delete process.env.SLA_SWEEP_BATCH;
});

describe('SlaSweepJob — scheduling', () => {
  it('registers ONE repeatable job on the sweep queue with the default interval', async () => {
    const { job, add } = build();
    await job.onModuleInit();
    expect(QueueMock).toHaveBeenCalledWith(SLA_SWEEP_QUEUE, expect.anything());
    expect(add).toHaveBeenCalledTimes(1);
    const [name, , opts] = add.mock.calls[0]! as [string, unknown, { repeat: { every: number } }];
    expect(name).toBe(SLA_SWEEP_JOB);
    expect(opts.repeat.every).toBe(30_000);
  });

  // Without a stable jobId every boot would add another repeatable entry, and N replicas would sweep
  // N times per interval — a silent multiplication nobody would notice.
  it('uses a STABLE job id so re-registration is idempotent across restarts and replicas', async () => {
    const { job, add } = build();
    await job.onModuleInit();
    expect((add.mock.calls[0]![2] as { jobId: string }).jobId).toBe(SLA_SWEEP_JOB);
  });

  it('honours a configured interval (Track B uses a few seconds)', async () => {
    const { job, add } = build({ SLA_SWEEP_INTERVAL_MS: '5000' });
    await job.onModuleInit();
    expect((add.mock.calls[0]![2] as { repeat: { every: number } }).repeat.every).toBe(5_000);
  });

  it('clamps a nonsense interval instead of hot-looping', async () => {
    const { job, add } = build({ SLA_SWEEP_INTERVAL_MS: '0' });
    await job.onModuleInit();
    expect((add.mock.calls[0]![2] as { repeat: { every: number } }).repeat.every).toBe(1_000);
  });

  it('runs one sweep at a time (overlapping ticks would only find nothing)', async () => {
    const { job } = build();
    await job.onModuleInit();
    expect((WorkerMock.mock.calls[0]![2] as { concurrency: number }).concurrency).toBe(1);
  });

  // A worker that cannot schedule is degraded, not broken; crashing the process would take the health
  // surface down with it.
  it('does not throw when scheduling fails', async () => {
    const { job, add } = build();
    add.mockRejectedValueOnce(new Error('redis down'));
    await expect(job.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('SlaSweepJob — processing', () => {
  it('calls the maintenance RPC with the configured batch', async () => {
    const { job, sweepFirstReplySla, runProcessor } = build({ SLA_SWEEP_BATCH: '250' });
    await job.onModuleInit();
    await runProcessor();
    expect(sweepFirstReplySla).toHaveBeenCalledWith(250);
  });

  it('uses the default batch when unset, and clamps a silly one', async () => {
    const a = build();
    await a.job.onModuleInit();
    await a.runProcessor();
    expect(a.sweepFirstReplySla).toHaveBeenCalledWith(500);

    const b = build({ SLA_SWEEP_BATCH: '999999' });
    await b.job.onModuleInit();
    await b.runProcessor();
    expect(b.sweepFirstReplySla).toHaveBeenCalledWith(5_000);
  });

  // Two overlapping ticks are harmless by DB state (marking a row removes it from the predicate), so
  // the processor needs no locking of its own — it just must not blow up.
  it('is safe to run twice back to back', async () => {
    const { job, sweepFirstReplySla, runProcessor } = build();
    await job.onModuleInit();
    await Promise.all([runProcessor(), runProcessor()]);
    expect(sweepFirstReplySla).toHaveBeenCalledTimes(2);
  });

  it('propagates an RPC failure to BullMQ so the tick is retried, without crashing the process', async () => {
    const { job, sweepFirstReplySla, runProcessor, handlers } = build();
    await job.onModuleInit();
    sweepFirstReplySla.mockRejectedValueOnce(new Error('chats down'));
    await expect(runProcessor()).rejects.toThrow('chats down');
    // …and the worker's own error hooks are registered so an unhandled failure cannot kill the worker.
    expect(Object.keys(handlers()).sort()).toEqual(['error', 'failed']);
    expect(() => handlers().failed!({ id: '1' }, new Error('x'))).not.toThrow();
    expect(() => handlers().error!(new Error('x'))).not.toThrow();
  });
});

describe('SlaSweepJob — shutdown', () => {
  it('closes the worker and the queue', async () => {
    const { job, close } = build();
    await job.onModuleInit();
    await job.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('tolerates a close failure', async () => {
    const { job, close } = build();
    await job.onModuleInit();
    close.mockRejectedValue(new Error('nope'));
    await expect(job.onModuleDestroy()).resolves.toBeUndefined();
  });
});

/**
 * Found by the first live run (feature 014 Track B): a failing sweep logged bare `Error`, and the real
 * cause was only visible in the chats logs. For a job that is silent by design, its one failure line has
 * to carry enough to act on.
 */
describe('SlaSweepJob — failure diagnosability', () => {
  it('logs the error name AND its first message line', async () => {
    const { job, handlers } = build();
    await job.onModuleInit();
    const warn = jest.spyOn(
      (job as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    handlers().failed!(
      { id: '7' },
      Object.assign(new Error('The table `public.ConversationSlaState` does not exist\nat foo'), {
        name: 'PrismaClientKnownRequestError',
      }),
    );
    const line = String(warn.mock.calls.at(-1)![0]);
    expect(line).toContain('PrismaClientKnownRequestError');
    expect(line).toContain('ConversationSlaState');
    expect(line).not.toContain('at foo'); // first line only — no stack in the log
  });

  it('caps a very long message', async () => {
    const { job, handlers } = build();
    await job.onModuleInit();
    const warn = jest.spyOn(
      (job as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    handlers().failed!({ id: '8' }, new Error('x'.repeat(5_000)));
    expect(String(warn.mock.calls.at(-1)![0]).length).toBeLessThan(300);
  });

  it('tolerates a non-Error failure', async () => {
    const { job, handlers } = build();
    await job.onModuleInit();
    expect(() => handlers().failed!({ id: '9' }, undefined as never)).not.toThrow();
  });
});
