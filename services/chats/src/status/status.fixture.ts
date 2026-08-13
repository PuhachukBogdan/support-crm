import { SEEDED_STATUSES, STATUS_CATEGORIES, type StatusCategory } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { StatusRepository } from './status.repository';

/**
 * TEST INFRASTRUCTURE for the status catalogue (feature 032). **Not product code**, and no service
 * imports it — the same standing as `libs/common/src/testing`, which exists for the structural guards.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────────────────────────
 * Statuses moved from a four-value enum into per-account rows, so a dozen existing specs that build a
 * repository or a controller now need a catalogue to validate against. Written inline that would be a
 * dozen slightly different nine-row fakes, and the first one to drift would make its spec assert a
 * vocabulary the product does not have.
 *
 * ⇒ ONE fixture, built from the SEEDED SET the migration and the seed both use, so a spec's idea of
 * "the statuses" cannot disagree with the product's.
 */
export function fakeStatusRepository(keys?: readonly string[]): StatusRepository {
  const rows = keys
    ? keys.map((key) => ({ key, category: categoryOf(key), active: true }))
    : SEEDED_STATUSES.map((s) => ({ key: s.key, category: s.category, active: true }));

  const conversationStatus = {
    findMany: async (args?: { where?: { category?: unknown; active?: unknown } }) => {
      const where = args?.where ?? {};
      return rows.filter((r) => {
        if (where.active === true && !r.active) return false;
        const cat = where.category as { in?: string[] } | string | undefined;
        if (typeof cat === 'string') return r.category === cat;
        if (cat && Array.isArray(cat.in)) return cat.in.includes(r.category);
        return true;
      });
    },
    findFirst: async (args?: { where?: { key?: string; active?: boolean } }) => {
      const w = args?.where ?? {};
      return (
        rows.find((r) => r.key === w.key && (w.active === undefined || r.active === w.active)) ?? null
      );
    },
  };

  return new StatusRepository({ forAccount: () => ({ conversationStatus }) } as unknown as PrismaService);
}

/** The seeded category of a key, or `open` for a key the fixture's caller invented. */
function categoryOf(key: string): StatusCategory {
  const seeded = SEEDED_STATUSES.find((s) => s.key === key);
  if (seeded) return seeded.category;
  // A test may name a status the seed set does not have. `open` is the honest default: non-terminal and
  // unremarkable, so it changes no assertion about terminality unless the test asked for one.
  return (Object.keys(STATUS_CATEGORIES) as StatusCategory[]).includes(key as StatusCategory)
    ? (key as StatusCategory)
    : 'open';
}
