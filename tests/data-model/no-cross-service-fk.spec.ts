import { parseSchema, modelNames, SERVICES } from './schema-scan';

/**
 * T3 / SC-002 / FR-010 (Principle VIII): no Prisma relation crosses a schema boundary — a
 * cross-service foreign key is structurally forbidden (DB-per-service). Cross-service reads go
 * through the gRPC contracts (auth/users/brands.proto), never a DB join. Soft references
 * (e.g. PlayerBrand.brand_id, BrandAccessRule.operator_id) are plain String columns, not
 * relations, so they are correctly invisible to this scan.
 */
describe('no cross-service relations (Principle VIII)', () => {
  it('the schemas define real relations (guards against a vacuous pass)', () => {
    const relationCount = SERVICES.flatMap((s) => parseSchema(s)).flatMap((m) =>
      m.fields.filter((f) => f.isRelation),
    ).length;
    expect(relationCount).toBeGreaterThan(0);
  });

  it.each(SERVICES)('%s: every relation targets a model in the SAME schema', (service) => {
    const own = modelNames(service);
    for (const model of parseSchema(service)) {
      for (const field of model.fields.filter((f) => f.isRelation)) {
        expect(own.has(field.baseType)).toBe(true);
      }
    }
  });
});
