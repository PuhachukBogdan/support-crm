import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * US3 / SC-005 (feature 008, Principle VIII): each service's seed writes ONLY its own database — it
 * imports only its own generated client (`../src/generated/prisma`) + `@crm/common`, never another
 * service's client/DB. Guards against a seed accidentally becoming a cross-service writer.
 */
const DATA_SERVICES = ['auth', 'users', 'brands', 'chats'];

function read(service: string, file: string): string {
  return readFileSync(resolve(__dirname, '..', '..', 'services', service, 'prisma', file), 'utf8');
}

describe('US3 — per-service seed isolation (Principle VIII)', () => {
  it.each(DATA_SERVICES)('%s: seed.ts imports only its own generated client', (service) => {
    const text = read(service, 'seed.ts');
    // Its own client via the local relative path.
    expect(text).toMatch(/from ['"]\.\.\/src\/generated\/prisma['"]/);
    // No OTHER service's generated client, package, or a relative hop into it.
    for (const other of DATA_SERVICES.filter((s) => s !== service)) {
      expect(text.includes(`services/${other}/`)).toBe(false);
      expect(text.includes(`@crm/${other}`)).toBe(false);
      expect(new RegExp(`\\/${other}\\/src\\/generated`).test(text)).toBe(false);
    }
  });

  it.each(DATA_SERVICES)('%s: seed.build.ts is pure (no Prisma client import)', (service) => {
    const text = read(service, 'seed.build.ts');
    expect(text.includes('generated/prisma')).toBe(false);
    expect(text.includes('PrismaClient')).toBe(false);
  });
});
