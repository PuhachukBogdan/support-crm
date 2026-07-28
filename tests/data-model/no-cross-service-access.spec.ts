import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSchema, modelNames, SERVICES, type Service } from './schema-scan';

/**
 * US2 / SC-004 (feature 007, Principle VIII): a service reaches another service's data ONLY through
 * the feature-006 gRPC contracts — never a cross-service DB relation or an import of another
 * service's generated Prisma client. This is the runtime-access regression guard on top of the 006
 * structural "zero cross-service relations" guarantee.
 */

const DATA_SERVICES: Service[] = ['auth', 'users', 'brands', 'chats'];

/**
 * A file's CODE, with comments removed — adopted from feature 016's single-ingest-path scan (2026-07-30,
 * feature 017).
 *
 * The scans below match on source text, and this codebase documents its decisions at length: a client
 * that explains WHY the storage credentials live in `services/users/src/uploads` names that path in
 * prose. Matching raw text flags that explanation as a cross-service import, and the repair a developer
 * then reaches for is DELETING the explanation — which is exactly the wrong outcome, because the prose is
 * why the boundary is understood.
 *
 * Stripping comments costs nothing in strength: an import inside a comment does not execute. It means the
 * scan polices behaviour rather than vocabulary. Feature 016's equivalent test made this same choice for
 * the same reason; this brings the 007 scan into line with it.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSDoc
    // `[ \t]` — indented `//` lines count as whole-line comments, which most of them are.
    .replace(/^[ \t]*\/\/.*$/gm, '') // whole-line // comments
    .replace(/([^:'"`])\/\/.*$/gm, '$1'); // trailing // comments (leaves URLs in strings alone)
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    // node's Dirent.path/parentPath varies by version — recompute from name is unsafe, so read via the entry's parentPath.
    .map((e) => resolve((e as { parentPath?: string; path?: string }).parentPath ?? (e as { path?: string }).path ?? dir, e.name));
}

describe('US2 — no cross-service data path (Principle VIII)', () => {
  it.each(SERVICES)('%s: every Prisma relation targets a model in the SAME schema', (service) => {
    const own = modelNames(service);
    for (const model of parseSchema(service)) {
      for (const field of model.fields.filter((f) => f.isRelation)) {
        expect(own.has(field.baseType)).toBe(true);
      }
    }
  });

  it.each(DATA_SERVICES)('%s: imports no OTHER service generated client / package', (service) => {
    const others = DATA_SERVICES.filter((s) => s !== service);
    const srcDir = resolve(__dirname, '..', '..', 'services', service, 'src');
    const offenders: string[] = [];

    for (const file of tsFiles(srcDir)) {
      const text = codeOf(file);
      for (const other of others) {
        // Another service's generated client, or its workspace package, or a relative hop into it.
        if (
          text.includes(`services/${other}/src`) ||
          text.includes(`@crm/${other}`) ||
          new RegExp(`from ['"][^'"]*\\/${other}\\/src\\/generated`).test(text)
        ) {
          offenders.push(`${file} → ${other}`);
        }
      }
      // The only generated-client import allowed is this service's own local one.
      const badGenerated = /from ['"](?!\.\/generated\/prisma)[^'"]*\/generated\/prisma['"]/.test(text);
      if (badGenerated) offenders.push(`${file} → non-local generated/prisma import`);
    }

    expect(offenders).toEqual([]);
  });
});
