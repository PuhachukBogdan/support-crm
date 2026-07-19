import { parseSchema, SERVICES, hasField, columnIsIndexed } from './schema-scan';

/**
 * T6 / FR-014 (Principle VII): every scope/lookup column that real queries filter on —
 * `account_id`, `player_id`, `brand_id` — is indexed, and any composite index that includes
 * `account_id` LEADS with it (matches how every tenant query filters first by account). No
 * exact-COUNT / OFFSET assumptions — keyset-friendly design. Sized for ~372K tickets.
 */
describe('hot-column indexing (Principle VII)', () => {
  const HOT = ['account_id', 'player_id', 'brand_id'];

  it.each(SERVICES)('%s: every present hot column is indexed', (service) => {
    const models = parseSchema(service);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      for (const col of HOT) {
        if (hasField(model, col)) {
          expect({ model: model.name, col, indexed: columnIsIndexed(model, col) }).toEqual({
            model: model.name,
            col,
            indexed: true,
          });
        }
      }
    }
  });

  it.each(SERVICES)('%s: composite indexes containing account_id lead with it', (service) => {
    for (const model of parseSchema(service)) {
      for (const idx of model.indexes) {
        if (idx.columns.length > 1 && idx.columns.includes('account_id')) {
          expect(idx.columns[0]).toBe('account_id');
        }
      }
    }
  });
});
