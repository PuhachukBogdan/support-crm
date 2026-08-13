import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import {
  STAFF_OFFBOARDING_JOB,
  STAFF_OFFBOARDING_QUEUE,
  StaffOffboardingJob,
} from './staff-offboarding.job';
import type { RedisService } from '../queue/redis.service';
import type { AuthStaffClient } from '../auth/auth.client';
import type { UsersMaintenanceClient } from '../users/users.client';
import type { ChatsMaintenanceClient } from '../chats/chats.client';

jest.mock('bullmq');

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §3/§4, SEC-PV2) — **the tick that finishes an
 * offboarding**, driven through the same door BullMQ uses (the idiom of `sla-sweep.job.spec.ts`).
 *
 * Nothing here needs proving about Redis. What needs proving is the three-service handshake, because
 * every one of its failure modes is silent: no request 500s, nobody waiting on the answer, and the
 * only external evidence is a conversation that quietly stays with somebody who has left.
 *
 * ── ⚠️ The one defect this file exists for, above all the others ─────────────────────────────────
 * The pass reads people from **auth** (`auth.User.id`) and hands work over in **chats**, which knows
 * an assignee by **`users.Operator.id`**. Two id spaces, both opaque strings, both plausible in the
 * same slot. Pass the wrong one and chats matches no conversation, answers `moved: 0`, and the sweep
 * reports a clean handover for somebody holding all of their work — for ever, with nothing red
 * anywhere. `tests/worker/maintenance-ticks.spec.ts` caught that shape in the gateway draft before it
 * ran once; this is the behavioural half, and it asserts the id **by inequality** as well as by value,
 * because «equals the operator id» alone still passes the day the two fixtures accidentally agree.
 */
const QueueMock = Queue as unknown as jest.Mock;
const WorkerMock = Worker as unknown as jest.Mock;

/** Deliberately dissimilar, deliberately not interchangeable — see the header. */
const ACCOUNT = 'acc-9f2c1b70-0000-4000-8000-000000000001';
const AUTH_USER = 'authusr-2f5d8e91-0000-4000-8000-0000000000aa';
const OPERATOR = 'oper-7c31a4b2-0000-4000-8000-0000000000ff';
const AUTH_USER_2 = 'authusr-2f5d8e91-0000-4000-8000-0000000000bb';
const OPERATOR_2 = 'oper-7c31a4b2-0000-4000-8000-0000000000ee';

const NOTHING = { moved: 0, noDesk: 0, skippedShelved: 0, remaining: 0 };
const TWO_PEOPLE = [
  { accountId: ACCOUNT, userId: AUTH_USER },
  { accountId: ACCOUNT, userId: AUTH_USER_2 },
];

function build(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
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

  const listDisabledStaff = jest.fn().mockResolvedValue([{ accountId: ACCOUNT, userId: AUTH_USER }]);
  const setOperatorActive = jest.fn().mockResolvedValue({ changed: true, operatorId: OPERATOR });
  const returnOperatorWorkToBacklog = jest
    .fn()
    .mockResolvedValue({ moved: 2, noDesk: 1, skippedShelved: 0, remaining: 3 });

  const job = new StaffOffboardingJob(
    { client: {} } as unknown as RedisService,
    { listDisabledStaff } as unknown as AuthStaffClient,
    { setOperatorActive } as unknown as UsersMaintenanceClient,
    { returnOperatorWorkToBacklog } as unknown as ChatsMaintenanceClient,
  );
  return {
    job,
    add,
    close,
    listDisabledStaff,
    setOperatorActive,
    returnOperatorWorkToBacklog,
    handlers: () => handlers,
    runProcessor: () => processor!({}),
  };
}

/** Every line the job prints FROM NOW ON — so the scheduling line cannot be counted as a pass's. */
function captureLogs(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(process.env)) if (k.startsWith('STAFF_')) delete process.env[k];
});

describe('StaffOffboardingJob — the sweep is scheduled and bounded', () => {
  it('registers ONE repeatable tick on its own queue, one pass at a time', async () => {
    const { job, add } = build();
    await job.onModuleInit();
    expect(QueueMock).toHaveBeenCalledWith(STAFF_OFFBOARDING_QUEUE, expect.anything());
    expect(add).toHaveBeenCalledTimes(1);
    const [name, , opts] = add.mock.calls[0]! as [string, unknown, { repeat: { every: number } }];
    expect(name).toBe(STAFF_OFFBOARDING_JOB);
    expect(opts.repeat.every).toBe(60_000);
    // Two overlapping passes would read the same people and race on the same conversations; every
    // loser's write is a no-op, so concurrency buys noise rather than throughput.
    expect((WorkerMock.mock.calls[0]![2] as { concurrency: number }).concurrency).toBe(1);
  });

  it('bounds a pass by BOTH the batch and the window it was configured with', async () => {
    // The window is what makes a «handled» flag unnecessary: somebody disabled longer ago than this
    // has been swept thousands of times already. If either argument stopped travelling, the sweep
    // would look healthy while re-reading either nobody or the whole history every minute.
    const { job, listDisabledStaff, runProcessor } = build({
      STAFF_OFFBOARDING_BATCH: '7',
      STAFF_OFFBOARDING_WINDOW_DAYS: '3',
    });
    await job.onModuleInit();
    await runProcessor();
    expect(listDisabledStaff).toHaveBeenCalledWith(7, 3);
  });
});

describe('*** chats is named the OPERATOR id that USERS answered — never the auth user id ***', () => {
  it('sends users the auth id, chats the operator id, and both the account auth reported', async () => {
    const { job, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } = build();
    await job.onModuleInit();
    await runProcessor();

    // The two id spaces meet in exactly one place: users is asked BY auth id and answers an operator
    // id. Everything downstream must use the answer. The account travels too — a machine has no
    // account of its own, so a lost one is a cross-tenant write rather than a refusal.
    expect(setOperatorActive).toHaveBeenCalledWith(ACCOUNT, AUTH_USER, false);
    expect(returnOperatorWorkToBacklog).toHaveBeenCalledWith(ACCOUNT, OPERATOR, 50);

    // …and stated as an inequality too: see the header on why equality alone is not enough.
    expect(returnOperatorWorkToBacklog.mock.calls[0]).not.toContain(AUTH_USER);
  });

  it('takes them out of the routing pools BEFORE moving the work, never the reverse', async () => {
    // Order is load-bearing: work returned to the queue while the operator is still routable can be
    // handed straight back to the person who has left.
    const { job, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } = build();
    await job.onModuleInit();
    await runProcessor();
    expect(setOperatorActive.mock.invocationCallOrder[0]!).toBeLessThan(
      returnOperatorWorkToBacklog.mock.invocationCallOrder[0]!,
    );
  });
});

describe('StaffOffboardingJob — somebody who never took a conversation', () => {
  // `null` is an ordinary answer (users maps NOT_FOUND to it): plenty of accounts belong to people who
  // never worked a queue. proto3 has no null either, so an absent operator id arrives as `''` — the
  // same absence spelled differently. Without both arms the pass would ask chats to hand over the work
  // of operator «», which matches nothing and reports a clean sweep: the id bug by another door.
  it.each([
    ['users holds no operator row (null)', null],
    ['the operator id came back empty', { changed: false, operatorId: '' }],
  ])('skips the person when %s, and asks chats nothing', async (_label, answer) => {
    const { job, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } = build();
    setOperatorActive.mockResolvedValueOnce(answer);
    await job.onModuleInit();
    await runProcessor();
    expect(returnOperatorWorkToBacklog).not.toHaveBeenCalled();
  });
});

describe('*** one person’s failure does not end the pass ***', () => {
  // The property the whole tick design was chosen for. In-request, a failure on person A is reported
  // to the HR platform and retried by a system we neither control nor test; here A is picked up by the
  // next tick — but only if B was still processed today. One misconfigured account must not be able to
  // block every other offboarding indefinitely.
  it('processes the SECOND person after users fails on the first', async () => {
    const { job, listDisabledStaff, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } =
      build();
    listDisabledStaff.mockResolvedValue(TWO_PEOPLE);
    setOperatorActive
      .mockRejectedValueOnce(new Error('users unavailable'))
      .mockResolvedValueOnce({ changed: true, operatorId: OPERATOR_2 });

    await job.onModuleInit();
    await expect(runProcessor()).resolves.toBeUndefined();
    expect(setOperatorActive).toHaveBeenCalledTimes(2);
    expect(returnOperatorWorkToBacklog).toHaveBeenCalledTimes(1);
    expect(returnOperatorWorkToBacklog).toHaveBeenCalledWith(ACCOUNT, OPERATOR_2, 50);
  });

  it('processes the second person after the HANDOVER itself fails on the first', async () => {
    const { job, listDisabledStaff, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } =
      build();
    listDisabledStaff.mockResolvedValue(TWO_PEOPLE);
    setOperatorActive
      .mockResolvedValueOnce({ changed: true, operatorId: OPERATOR })
      .mockResolvedValueOnce({ changed: true, operatorId: OPERATOR_2 });
    returnOperatorWorkToBacklog
      .mockRejectedValueOnce(new Error('chats unavailable'))
      .mockResolvedValueOnce(NOTHING);

    await job.onModuleInit();
    await expect(runProcessor()).resolves.toBeUndefined();
    expect(returnOperatorWorkToBacklog.mock.calls.map((c) => c[1])).toEqual([OPERATOR, OPERATOR_2]);
  });

  it('is safe run twice back to back — both follow-ups are no-ops with nothing to do', async () => {
    // Idempotence by predicate, which is why this feature needed no «handled» flag: setting an
    // inactive operator inactive answers `unchanged`, and re-running a handover answers `moved: 0`.
    const { job, returnOperatorWorkToBacklog, runProcessor } = build();
    returnOperatorWorkToBacklog.mockResolvedValue(NOTHING);
    await job.onModuleInit();
    await Promise.all([runProcessor(), runProcessor()]);
    expect(returnOperatorWorkToBacklog).toHaveBeenCalledTimes(2);
  });
});

describe('StaffOffboardingJob — a quiet pass is SILENT', () => {
  // A line every minute saying «0 moved» is how a log stops being read, and the line that matters here
  // (`noDesk` — work still stuck with somebody who left) is the one an administrator must act on.
  it('asks nobody anything, and prints nothing, when nobody has been offboarded lately', async () => {
    const { job, listDisabledStaff, setOperatorActive, returnOperatorWorkToBacklog, runProcessor } =
      build();
    listDisabledStaff.mockResolvedValue([]);
    await job.onModuleInit();
    const cap = captureLogs();
    await runProcessor();
    cap.restore();
    expect(setOperatorActive).not.toHaveBeenCalled();
    expect(returnOperatorWorkToBacklog).not.toHaveBeenCalled();
    expect(cap.lines).toEqual([]);
  });

  it('prints nothing when everybody it found was ALREADY handed over', async () => {
    // The steady state of this sweep: it re-reads the same recently-disabled people every tick and
    // writes nothing. That has to be as quiet as an empty list, or the window makes the log unreadable.
    const { job, returnOperatorWorkToBacklog, runProcessor } = build();
    returnOperatorWorkToBacklog.mockResolvedValue(NOTHING);
    await job.onModuleInit();
    const cap = captureLogs();
    await runProcessor();
    cap.restore();
    expect(cap.lines).toEqual([]);
  });
});

describe('*** nothing identifying is printed — counts only ***', () => {
  // Principle IV / SEC-26. This is the one tick in the worker whose REQUESTS carry identifiers (every
  // other sends a limit and receives counts), so it is the one where an id can reach a log by accident.
  // The list it reads is «who left the company recently»: an account, user or operator id in a log
  // makes that list durable, greppable, and outside every access control we have.
  const IDENTIFIERS = [ACCOUNT, AUTH_USER, OPERATOR];

  it('the summary line carries the counts and no identifier', async () => {
    const { job, runProcessor } = build();
    await job.onModuleInit();
    const cap = captureLogs();
    await runProcessor();
    cap.restore();

    expect(cap.lines).toHaveLength(1); // anti-vacuum: it did print, and we read what it printed.
    expect(cap.lines[0]).toContain('moved=2');
    expect(cap.lines[0]).toContain('noDesk=1');
    for (const id of IDENTIFIERS) expect(cap.lines[0]).not.toContain(id);
  });

  it.each([
    // The real shape of a refusal: chats' handover controller throws static RpcException messages.
    ['a refusal', new Error('9 FAILED_PRECONDITION: account has no non-terminal statuses configured')],
    [
      // ⚠️ Not hypothetical: Prisma puts the query ARGUMENTS into `message`, and an unexpected
      // repository error inside chats travels back as gRPC details. The arguments of this call are an
      // account id and an operator id. `firstLine()` is what keeps them out — they land below line one.
      'an upstream error echoing its query arguments',
      Object.assign(
        new Error(
          `Invalid \`prisma.conversation.findMany()\` invocation:\n\n{\n  where: {\n` +
            `    account_id: "${ACCOUNT}",\n    assignee_operator_id: "${OPERATOR}"\n  }\n}`,
        ),
        { name: 'PrismaClientValidationError' },
      ),
    ],
  ])('%s is logged as a count and a cause, with nothing identifying', async (_label, error) => {
    const { job, returnOperatorWorkToBacklog, runProcessor } = build();
    returnOperatorWorkToBacklog.mockRejectedValue(error);
    await job.onModuleInit();
    const cap = captureLogs();
    await runProcessor();
    cap.restore();

    const printed = cap.lines.join(' ');
    expect(printed).toContain('failed=1'); // enough to act on…
    for (const id of IDENTIFIERS) expect(printed).not.toContain(id); // …and nobody named.
  });

  it('no log template in the job interpolates an identifier at all', () => {
    /**
     * The structural half, and the one that survives a `catch` added next year: the tests above cover
     * only the paths somebody thought to exercise.
     *
     * ⚠️ This test's first version could only prove the job interpolates no id **of its own**, and
     * said so as a recorded limit: the per-person failure line quoted an UPSTREAM message, so a
     * single-line driver error naming an id (`invalid input syntax for type uuid: "oper-…"`) would
     * have printed it. **That was a real finding and the job was narrowed** (2026-08-13) — this is
     * the one tick whose REQUESTS carry identifiers, so the reasoning every other tick relies on
     * («we send a limit and receive counts») does not hold here. It now logs the error's NAME.
     * The remaining `firstLine` is on the queue-level handler, where the only uncaught call is
     * `ListDisabledStaff` — a limit and a day count, with nobody named in either direction.
     */
    const src = readFileSync(join(__dirname, 'staff-offboarding.job.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const calls = [...src.matchAll(/this\.logger\.\w+\(([\s\S]*?)\);/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThan(2); // anti-vacuum: the scan found the log calls.

    // Only the INTERPOLATED expressions are judged, never the literal text around them: the fixed
    // words of a message («staff offboarding: moved=…») name nobody, and scanning those instead would
    // be a check that fires on its own prose while a real `${person.userId}` slips past.
    const values = calls.flatMap((c) => [...c.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!));
    expect(values.length).toBeGreaterThan(4); // anti-vacuum: it found the values, not just the calls.
    expect(values.filter((e) => /\b(accountId|userId|operatorId|person|staff|email|operator)\b/.test(e)))
      .toEqual([]);

    // ⭐ And the narrowing itself, pinned: the PER-PERSON catch prints a class, never a message. It
    // is the only log line in this service reached while an identifier is in scope, so widening it
    // back to `firstLine(e.message)` must be a test failure rather than a plausible-looking tidy-up.
    const perPerson = calls.find((c) => c.includes('offboarding step failed'))!;
    expect(perPerson).toContain('name');
    expect(perPerson).not.toContain('message');
  });
});

describe('StaffOffboardingJob — a failing tick, and shutdown', () => {
  it('warns once when a tick fails, cutting the stack, without taking the process down', async () => {
    // The one warning anybody gets. A stopped offboarding sweep is invisible from outside: nothing
    // errors, and departed colleagues simply keep holding live conversations.
    //
    // ⓘ `toContain`, not an exact list, on purpose: this job registers only `failed`, while
    // `sla-sweep.job.ts` also registers `error` (a BullMQ worker emitting `error` with no listener is
    // an unhandled EventEmitter error, i.e. a dead worker process). Six of the seven jobs share this
    // gap, so it is not W31's to fix here — but pinning the list exactly would turn the fix into a
    // failing test, which is the wrong way round.
    const { job, handlers } = build();
    await job.onModuleInit();
    expect(Object.keys(handlers())).toContain('failed');
    const cap = captureLogs();
    expect(() =>
      handlers().failed!({ id: '1' }, Object.assign(new Error('redis gone\nat foo'), { name: 'Err' })),
    ).not.toThrow();
    expect(() => handlers().failed!({ id: '2' }, undefined as never)).not.toThrow();
    cap.restore();
    expect(cap.lines[0]).toContain('redis gone');
    expect(cap.lines[0]).not.toContain('at foo');
  });

  it('closes the worker and the queue, and tolerates a close failure', async () => {
    const { job, close } = build();
    await job.onModuleInit();
    await job.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(2);
    close.mockRejectedValue(new Error('nope'));
    await expect(job.onModuleDestroy()).resolves.toBeUndefined();
  });
});
