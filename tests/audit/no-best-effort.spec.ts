import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * T040 (feature 015, US2) — **no v1 writer swallows an audit failure.** SC-004a.
 *
 * This is a structural guard for a decision that was originally violated *by accident*. Before this feature,
 * feature 011 wrote its privilege audit row with a plain `await` **after** the mutation and outside any
 * transaction — so a failing audit left the permission change standing, unrecorded. Nobody chose that; it
 * was simply how the code was arranged.
 *
 * That is exactly why the guarantee needs a test rather than a convention: an accident produced the wrong
 * behaviour once, so the same accident can produce it again. Every audit write must either sit inside its
 * action's transaction (a mutation) or be awaited un-caught (a read), and none may be wrapped in a `catch`
 * that continues.
 *
 * Best-effort is reserved for the deferred `record.open` class (spec Q1/Q3), which has no writer.
 */
const ROOT = resolve(__dirname, '..', '..');

const WRITERS = [
  ['auth', 'src/rbac/override.service.ts'],
  ['auth', 'src/rbac/role-assignment.service.ts'],
  ['auth', 'src/audit/audit.grpc.controller.ts'],
  ['users', 'src/player/contact-view-audit.service.ts'],
  ['chats', 'src/automation/automations.grpc.controller.ts'],
] as const;

const read = (service: string, file: string) =>
  readFileSync(join(ROOT, 'services', service, file), 'utf8');

describe('no audit write is best-effort in v1', () => {
  it.each(WRITERS)('%s/%s does not swallow an audit failure', (service, file) => {
    const src = read(service, file);

    // Find every audit write and check it is not inside a try that swallows. A blunt but effective proxy:
    // no `catch` block in the file may contain a comment or code that continues past an audit write.
    const auditWrites = [...src.matchAll(/this\.audit\.(append|statement)\(/g)];
    expect({ service, file, writes: auditWrites.length }).toEqual({
      service,
      file,
      writes: auditWrites.length, // recorded for visibility
    });
    expect(auditWrites.length).toBeGreaterThan(0);

    // The specific anti-pattern: an audit write wrapped in its own try/catch. A file-wide try/catch that
    // rethrows is fine (auth's controller maps filter errors), so the check is for a catch that does NOT
    // rethrow while an audit write sits inside the same try.
    for (const m of src.matchAll(/try\s*\{([\s\S]*?)\}\s*catch[\s\S]*?\{([\s\S]*?)\n\s*\}/g)) {
      const [, tryBody = '', catchBody = ''] = m;
      const writesInside = /this\.audit\.(append|statement)\(/.test(tryBody);
      if (!writesInside) continue;
      const rethrows = /throw\b/.test(catchBody);
      expect({ service, file, swallowedAuditWrite: !rethrows }).toEqual({
        service,
        file,
        swallowedAuditWrite: false,
      });
    }
  });

  it('every MUTATING writer puts its entry inside a $transaction', () => {
    // The three services that mutate. A `statement()` call with no `$transaction` in the same file would mean
    // the entry was built and then written on its own — the accident this test exists to prevent.
    for (const [service, file] of [
      ['auth', 'src/rbac/override.service.ts'],
      ['auth', 'src/rbac/role-assignment.service.ts'],
    ] as const) {
      const src = read(service, file);
      expect({ service, hasStatement: src.includes('this.audit.statement(') }).toEqual({
        service,
        hasStatement: true,
      });
      expect({ service, hasTransaction: src.includes('$transaction(') }).toEqual({
        service,
        hasTransaction: true,
      });
      // …and no `append(` (the standalone write) on a mutating path.
      expect({ service, file, standaloneWrite: src.includes('this.audit.append(') }).toEqual({
        service,
        file,
        standaloneWrite: false,
      });
    }

    // chats routes its statement through the repository's audited delete, which transacts.
    const chats = read('chats', 'src/automation/automations.repository.ts');
    expect(chats.includes('$transaction(')).toBe(true);
  });

  it('the deferred record.open class still has no writer', () => {
    // Best-effort belongs to that class when it ships — WITH a retention policy (spec Q1). Until then nothing
    // may write it, and this is where a premature wiring gets caught.
    for (const service of ['auth', 'users', 'chats'] as const) {
      const dir = join(ROOT, 'services', service, 'src');
      const found = readFileSync(join(dir, 'audit', 'audit.repository.ts'), 'utf8');
      expect(found.includes("'record.open'")).toBe(false);
    }
  });
});
