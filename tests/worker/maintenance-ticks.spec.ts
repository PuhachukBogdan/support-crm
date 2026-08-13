import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * **Every maintenance RPC has a caller** — the Track A test that would have caught feature 017's
 * live-only defect, written the day it was found (2026-07-28).
 *
 * ── The defect ───────────────────────────────────────────────────────────────────────────────────
 * `ChatsMaintenanceService.ExpireDueExports` was written, hosted, unit-tested, and **called by nothing**.
 * Every completed export therefore stayed `ready` for ever, holding an artefact reference pointing at
 * bytes the purge had already destroyed. No unit test could see it: they call the sweep directly, and
 * nothing in a unit test knows whether a scheduler exists.
 *
 * ── Why this generalises ─────────────────────────────────────────────────────────────────────────
 * A maintenance RPC is defined by having **no user-facing caller** — no gateway route, no UI, no client
 * except a tick. That is exactly what makes it the one shape of dead code the product cannot notice: an
 * unused ordinary endpoint gets found the first time somebody tries the feature, and an untriggered sweep
 * gets found when an operator asks why nothing has been cleaned up in three months.
 *
 * Feature 015's live defect was the mirror image — a hosted PACKAGE whose handler was never wired — and
 * `services/users/src/maintenance/hosting.spec.ts` now covers that direction. This covers the other.
 */
const ROOT = resolve(__dirname, '..', '..');
const PROTO_DIR = join(ROOT, 'libs', 'proto');
const WORKER_SRC = join(ROOT, 'services', 'worker', 'src');

function walk(dir: string, out: string[] = [], ext = '.ts'): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, ext);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** Every `rpc X(...)` declared inside a service whose name ends in `MaintenanceService`. */
function maintenanceRpcs(): Array<{ service: string; rpc: string; file: string }> {
  const found: Array<{ service: string; rpc: string; file: string }> = [];
  for (const file of walk(PROTO_DIR, [], '.proto')) {
    const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    for (const m of src.matchAll(/service\s+(\w*MaintenanceService)\s*\{([\s\S]*?)\n\}/g)) {
      const service = m[1]!;
      for (const r of (m[2] ?? '').matchAll(/rpc\s+(\w+)\s*\(/g)) {
        found.push({ service, rpc: r[1]!, file: rel(file) });
      }
    }
  }
  return found;
}

const RPCS = maintenanceRpcs();

/** The worker's source, comments stripped — a mention in prose is not a call. */
const WORKER_CODE = walk(WORKER_SRC)
  .filter((f) => !f.endsWith('.spec.ts'))
  .map((f) => ({ file: rel(f), code: stripComments(readFileSync(f, 'utf8')) }));

/** Method name as the worker's client would spell it: `ExpireDueExports` → `expireDueExports`. */
const camel = (rpc: string) => rpc.charAt(0).toLowerCase() + rpc.slice(1);

describe('the scan sees the maintenance surface (guards against a vacuous pass)', () => {
  it('finds every maintenance service and RPC in the proto tree', () => {
    const names = RPCS.map((r) => `${r.service}.${r.rpc}`).sort();
    // Pinned: a NEW maintenance RPC should have to appear here, which is the review moment where somebody
    // asks "and what calls it?".
    expect(names).toEqual([
      // ⭐ Feature 031 (roadmap 4.20). The review moment this pin exists for happened again: declaring
      // `DrainBacklog` turned this suite red, and the answer to "what calls it?" is the 30-second SLA
      // tick — the same granularity the subject sweep rides, so a conversation waits at most one tick
      // after a colleague frees a slot. A queue nothing drains is a queue that silently keeps work.
      'ChatsMaintenanceService.DrainBacklog',
      'ChatsMaintenanceService.ExpireDueExports',
      // Feature 023 (roadmap 4.8a). The review moment this pin exists for actually happened: declaring
      // it turned this suite red before a single line of the handler was written, and the answer to
      // "what calls it?" is the expiry tick — a five-minute heartbeat, which is the right frequency
      // for "has recording stopped".
      'ChatsMaintenanceService.ReportTransitionStreamHealth',
      'ChatsMaintenanceService.RunDueExports',
      // Feature 023 (roadmap 4.18). Same review moment, second time: the answer to "what calls it?" is
      // the SLA tick and NOT the expiry tick — the title window is ten minutes, and a five-minute
      // heartbeat would close it anywhere between ten and fifteen.
      'ChatsMaintenanceService.SweepConversationSubjects',
      'ChatsMaintenanceService.SweepFirstReplySla',
      'UsersMaintenanceService.PurgeExpiredArtefacts',
      // Feature 025 (roadmap 5.9). Third time, and the answer to "what calls it?" is a tick of its
      // OWN — the interval is added directly to the away threshold as lag, so a five-minute
      // heartbeat would make a ten-minute threshold mean "ten to fifteen". A separate queue also
      // stops a stuck presence pass from delaying artefact deletion, or the reverse.
      'UsersMaintenanceService.SweepIdlePresence',
    ]);
  });

  it('reads the worker source', () => {
    expect(WORKER_CODE.length).toBeGreaterThan(5);
    expect(WORKER_CODE.map((f) => f.file)).toContain('services/worker/src/app.module.ts');
  });
});

describe('*** every maintenance RPC is CALLED by the worker ***', () => {
  it.each(RPCS.map((r) => [`${r.service}.${r.rpc}`, r.rpc]))(
    '%s has a client method call',
    (_label, rpc) => {
      const method = camel(rpc);
      const callers = WORKER_CODE.filter((f) =>
        new RegExp(`\\.${method}\\s*\\(`).test(f.code),
      ).map((f) => f.file);
      // At least two: the client that declares the method, and the job that invokes it.
      expect({ rpc, callers: callers.length > 0 }).toEqual({ rpc, callers: true });
    },
  );

  it.each(RPCS.map((r) => [`${r.service}.${r.rpc}`, r.rpc]))(
    '%s is reached from a JOB, not only declared on a client',
    (_label, rpc) => {
      const method = camel(rpc);
      // The load-bearing half. `ExpireDueExports` had a client method and no job calling it, so a scan for
      // "does the name appear anywhere in the worker" would have passed while the sweep never ran.
      const jobs = WORKER_CODE.filter(
        (f) => f.file.includes('/jobs/') && new RegExp(`\\.${method}\\s*\\(`).test(f.code),
      ).map((f) => f.file);
      expect({ rpc, jobs }).toEqual({ rpc, jobs: expect.arrayContaining([expect.any(String)]) });
    },
  );

  it('every job is registered in the worker module', () => {
    // A job class nobody provides is never constructed, so its `onModuleInit` never schedules anything —
    // the same defect one level up.
    const appModule = WORKER_CODE.find((f) => f.file.endsWith('app.module.ts'))!.code;
    const jobClasses = WORKER_CODE.filter((f) => f.file.includes('/jobs/')).flatMap((f) =>
      [...f.code.matchAll(/export class (\w+Job)\b/g)].map((m) => m[1]!),
    );
    expect(jobClasses.length).toBeGreaterThan(2);
    const unregistered = jobClasses.filter((c) => !new RegExp(`\\b${c}\\b`).test(appModule));
    expect(unregistered).toEqual([]);
  });
});

describe('*** and no maintenance RPC is reachable from the gateway ***', () => {
  it('the gateway names none of them', () => {
    // The other half of a maintenance RPC's definition: only a tick may call it. If HTTP can ask, the
    // system-actor check is decoration.
    const gateway = walk(join(ROOT, 'services', 'gateway', 'src'))
      .filter((f) => !f.endsWith('.spec.ts'))
      .map((f) => ({ file: rel(f), code: stripComments(readFileSync(f, 'utf8')) }));
    const offenders: string[] = [];
    for (const { service, rpc } of RPCS) {
      for (const f of gateway) {
        if (f.code.includes(rpc) || f.code.includes(service)) offenders.push(`${f.file} → ${rpc}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
