import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * T037 (feature 015, US2) — **there is no path that edits or deletes an audit entry.** SC-003.
 *
 * This is a structural scan rather than a permission check, and the distinction is the whole point:
 * "nobody currently holds that permission" is a promise about configuration, while "no such code path
 * exists" is a promise about the product. An audit trail whose integrity rests on the first can be undone
 * by a role edit; one that rests on the second cannot be undone at all without a code change that fails
 * this test.
 *
 * It also covers the owner. Audit integrity is deliberately not a capability anyone can be granted — there
 * is no super-admin escape hatch, because the whole reason the trail exists is to record what powerful
 * people did.
 */
const ROOT = resolve(__dirname, '..', '..');
const SERVICES = ['auth', 'users', 'chats', 'gateway'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const sources = SERVICES.flatMap((s) => walk(join(ROOT, 'services', s, 'src'))).concat(
  walk(join(ROOT, 'libs', 'common', 'src')),
);

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

describe('the audit trail is append-only, structurally', () => {
  it('finds the sources it is meant to police (guards against a vacuous pass)', () => {
    expect(sources.length).toBeGreaterThan(50);
    // …and that the audit code is actually among them.
    expect(sources.some((f) => rel(f).includes('/audit/audit.repository.ts'))).toBe(true);
  });

  // The forbidden operations, spelled out. `create` and the read operations are fine; anything that could
  // change or remove an existing row is not.
  const FORBIDDEN = [
    'auditEntry.update',
    'auditEntry.updateMany',
    'auditEntry.upsert',
    'auditEntry.delete',
    'auditEntry.deleteMany',
    'auditEntry.createManyAndReturn', // not a mutation of history, but not a path we sanction either
    'AuditEntry"\n' /* raw SQL guard, see below */,
  ];

  it.each(SERVICES)('%s: no source performs a mutating auditEntry operation', (service) => {
    const files = walk(join(ROOT, 'services', service, 'src'));
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN.slice(0, 6)) {
        expect({ file: rel(file), forbidden, found: src.includes(forbidden) }).toEqual({
          file: rel(file),
          forbidden,
          found: false,
        });
      }
    }
  });

  it('no raw SQL updates or deletes the table (the extension does not police $queryRaw)', () => {
    // `$queryRaw` / `$executeRaw` bypass the Prisma client extension, so they bypass account scoping too —
    // and would bypass this guarantee. Nothing may name the table in raw SQL outside a migration.
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (!/\$(queryRaw|executeRaw)/.test(src)) continue;
      expect({ file: rel(file), mentionsTable: /AuditEntry/.test(src) }).toEqual({
        file: rel(file),
        mentionsTable: false,
      });
    }
  });

  it('the repository exposes append + read, and nothing that could change history', () => {
    for (const service of ['auth', 'users', 'chats'] as const) {
      const src = readFileSync(
        join(ROOT, 'services', service, 'src', 'audit', 'audit.repository.ts'),
        'utf8',
      );
      // The three sanctioned entry points exist…
      for (const method of ['append(', 'statement(', 'list(']) {
        expect({ service, method, present: src.includes(method) }).toEqual({
          service,
          method,
          present: true,
        });
      }
      // …and nothing whose NAME implies changing or removing an entry. Asserted on names as well as on the
      // Prisma calls above, because a helper could wrap a mutation without naming the operation.
      const mutating = [...src.matchAll(/^\s{2}(?:async\s+)?(\w*(?:update|delete|remove|purge|trim)\w*)\s*\(/gim)];
      expect({ service, mutating: mutating.map((m) => m[1]) }).toEqual({ service, mutating: [] });
    }
  });

  it('the gateway declares exactly one audit route, and it is a GET', () => {
    const files = walk(join(ROOT, 'services', 'gateway', 'src', 'audit'));
    const routes: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)) routes.push(m[1]!);
    }
    expect(routes).toEqual(['Get']);
  });

  it('no service exposes a write/update/delete audit RPC', () => {
    const proto = readFileSync(
      join(ROOT, 'libs', 'proto', 'crm', 'audit', 'v1', 'audit.proto'),
      'utf8',
    );
    for (const forbidden of ['WriteAuditEntry', 'UpdateAuditEntry', 'DeleteAuditEntry']) {
      // Present only inside the "what is deliberately absent" comment block, never as an rpc.
      expect(new RegExp(`rpc\\s+${forbidden}`).test(proto)).toBe(false);
    }
    for (const service of ['auth', 'users', 'chats'] as const) {
      const svcProto = readFileSync(
        join(ROOT, 'libs', 'proto', 'crm', service, 'v1', `${service}.proto`),
        'utf8',
      );
      expect(/rpc\s+\w*AuditEntr\w*/.test(svcProto.replace(/rpc\s+ListAuditEntries/g, ''))).toBe(false);
    }
  });
});
