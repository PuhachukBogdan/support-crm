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
      const text = readFileSync(file, 'utf8');
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
