import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T025 (feature 031, FR-009 / SC-003) — **an agent has no way to take an item out of the backlog.**
 *
 * ADR 0042 lets agents SEE the backlog for load awareness and never pick from it. The strongest form of
 * that rule is not a refusal but an **absence**: if no rpc and no route accepts "give me that one", then
 * the request cannot be composed, the refusal never has to be written, tested or maintained, and no future
 * caller can discover a path nobody meant to leave open.
 *
 * ⚠️ **This is why the guard reads the CONTRACT and not the code.** A test of behaviour would assert that
 * some handler refuses; this asserts there is nothing to call. Feature 030 learned the difference the
 * expensive way: a guard against *naming* a role was green while the pool could still hand work to an
 * account manager, because the rule was enforced at the vocabulary and never at the surface.
 *
 * ── Dear implementer who just went red ─────────────────────────────────────────────────────────
 * If you are adding a way for a person to take queued work, that is a **product decision** and not a
 * refactor: it inverts "the system distributes" into "agents pick", which is the question roadmap Q30
 * deliberately left open. Raise it rather than widening this list.
 */

const PROTO_DIR = join(__dirname, '..', '..', '..', '..', 'libs', 'proto', 'crm');
const GATEWAY_SRC = join(__dirname, '..', '..', '..', 'gateway', 'src');

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext) && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Words that would name a "take it" operation. Deliberately broad: the point is that **no** verb of this
 * shape exists anywhere near the backlog, so a synonym cannot smuggle one in.
 */
const TAKE_VERBS = /(take|claim|grab|pull|pick|assignToMe|assign_to_me|self_assign|selfAssign)/i;
const BACKLOG_WORD = /backlog|queue/i;

describe('there is no path by which an agent takes queued work (T025)', () => {
  const protos = walk(PROTO_DIR, '.proto');
  const gatewayFiles = walk(GATEWAY_SRC, '.ts');

  it('the guard has files to read — it is not vacuous', () => {
    // Feature 030 shipped a guard whose glob matched nothing and would have passed for ever.
    expect(protos.length).toBeGreaterThan(0);
    expect(gatewayFiles.length).toBeGreaterThan(0);
  });

  it('⭐ no rpc combines a backlog word with a take verb', () => {
    const offenders: string[] = [];
    for (const file of protos) {
      for (const line of stripComments(readFileSync(file, 'utf8')).split('\n')) {
        if (!line.includes('rpc ')) continue;
        if (BACKLOG_WORD.test(line) && TAKE_VERBS.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⭐ no gateway route does either', () => {
    const offenders: string[] = [];
    for (const file of gatewayFiles) {
      for (const line of stripComments(readFileSync(file, 'utf8')).split('\n')) {
        if (!/@(Post|Put|Patch|Delete)\(/.test(line)) continue;
        if (BACKLOG_WORD.test(line) && TAKE_VERBS.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⚠️ the detector fires on planted examples, so the emptiness above means something', () => {
    // Proven rather than trusted: a regex that never matched would certify any contract.
    const planted = '  rpc TakeFromBacklog(TakeFromBacklogRequest) returns (Conversation);';
    expect(BACKLOG_WORD.test(planted) && TAKE_VERBS.test(planted)).toBe(true);
    const plantedRoute = "  @Post('backlog/:id/claim')";
    expect(BACKLOG_WORD.test(plantedRoute) && TAKE_VERBS.test(plantedRoute)).toBe(true);
    // …and it does not fire on a READ of the backlog, which is explicitly allowed (load awareness).
    const allowed = '  rpc ListBacklog(ListBacklogRequest) returns (BacklogPage);';
    expect(BACKLOG_WORD.test(allowed) && TAKE_VERBS.test(allowed)).toBe(false);
  });
});
