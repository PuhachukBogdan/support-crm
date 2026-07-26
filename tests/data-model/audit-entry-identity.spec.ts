import { parseSchema } from './schema-scan';
import type { Model, Service } from './schema-scan';

/**
 * T012 (feature 015) — **the three `AuditEntry` tables must stay identical.**
 *
 * The audit trail is ONE logical log that physically lives in three databases. That is not a design
 * preference: an entry must be written inside the transaction of the action it describes (spec Q3 — action
 * and entry succeed together), and a cross-service database write is forbidden (Principle VIII). So the
 * table is duplicated on purpose.
 *
 * The risk that creates is silent drift. Someone adds a column in auth, the gateway's merge starts reading
 * a field two of three sources do not have, and the federated log quietly disagrees with itself. A type
 * checker cannot catch it — the three Prisma models are independent declarations. This test is what makes
 * the duplication safe: change one, and you are told to change the other two.
 *
 * FAILS the moment the definitions diverge in fields, types, optionality or indexes.
 */
const SOURCES: Service[] = ['auth', 'users', 'chats'];

function auditModel(service: Service): Model {
  const model = parseSchema(service).find((m) => m.name === 'AuditEntry');
  if (!model) throw new Error(`${service}: no AuditEntry model — the audit trail needs one per source`);
  return model;
}

const models = new Map<Service, Model>(SOURCES.map((s) => [s, auditModel(s)]));

/** Field shape reduced to what must match: name, type, optionality. Comments and order-in-file are free. */
const fieldShape = (m: Model) =>
  m.fields
    .map((f) => `${f.name}:${f.baseType}${f.optional ? '?' : ''}${f.list ? '[]' : ''}`)
    .sort()
    .join(' | ');

/** Index shape reduced to kind + ordered columns. Index ORDER within the block is free; column order is not. */
const indexShape = (m: Model) =>
  m.indexes
    .map((i) => `${i.kind}(${i.columns.join(',')})`)
    .sort()
    .join(' | ');

describe('AuditEntry is defined identically in every source service', () => {
  it('exists in all three services', () => {
    expect([...models.keys()].sort()).toEqual([...SOURCES].sort());
  });

  it('has the same fields, types and optionality everywhere', () => {
    const shapes = SOURCES.map((s) => [s, fieldShape(models.get(s)!)] as const);
    const [, reference] = shapes[0]!;
    for (const [service, shape] of shapes) {
      // Compared as objects so a failure prints WHICH service diverged and how.
      expect({ service, shape }).toEqual({ service, shape: reference });
    }
  });

  it('has the same indexes everywhere', () => {
    const shapes = SOURCES.map((s) => [s, indexShape(models.get(s)!)] as const);
    const [, reference] = shapes[0]!;
    for (const [service, shape] of shapes) {
      expect({ service, shape }).toEqual({ service, shape: reference });
    }
  });

  // The fields the read surface and the writers depend on. Spelled out rather than inferred, so a rename
  // is a deliberate act that updates this list too.
  it.each(SOURCES)('%s: carries the required columns', (service) => {
    const names = models.get(service)!.fields.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        'account_id',
        'action',
        'actor_kind',
        'actor_ref',
        'actor_user_id',
        'created_at',
        'detail_json',
        'id',
        'target_ref',
        'under_preview',
      ].sort(),
    );
  });

  it.each(SOURCES)('%s: orders by (created_at, id) via an index that includes both', (service) => {
    const idx = models.get(service)!.indexes;
    // The read surface pages by (created_at DESC, id DESC) — two entries in the same instant must still
    // page deterministically, which only works if `id` participates in the ordering index.
    expect(
      idx.some(
        (i) =>
          i.kind === 'index' &&
          i.columns[0] === 'account_id' &&
          i.columns.includes('created_at') &&
          i.columns.includes('id'),
      ),
    ).toBe(true);
  });

  it.each(SOURCES)('%s: indexes the two question dimensions (actor, target)', (service) => {
    const idx = models.get(service)!.indexes;
    for (const column of ['actor_user_id', 'target_ref']) {
      expect(
        idx.some((i) => i.kind === 'index' && i.columns[0] === 'account_id' && i.columns.includes(column)),
      ).toBe(true);
    }
  });

  // A unique constraint here would be actively wrong: a retried sensitive action is a NEW act and deserves
  // its own entry (two grant attempts, one failed, is what a reviewer needs to see). Feature 014 needed one
  // because a scheduler could redeliver an event; nothing redelivers a human action.
  it.each(SOURCES)('%s: has NO unique constraint beyond the primary key', (service) => {
    const uniques = models
      .get(service)!
      .indexes.filter((i) => i.kind === 'unique' && !(i.columns.length === 1 && i.columns[0] === 'id'));
    expect(uniques).toEqual([]);
  });
});

describe('the legacy stores are gone', () => {
  it('auth no longer declares PrivilegeAudit', () => {
    expect(parseSchema('auth').map((m) => m.name)).not.toContain('PrivilegeAudit');
  });

  it('users no longer declares ContactViewAudit', () => {
    expect(parseSchema('users').map((m) => m.name)).not.toContain('ContactViewAudit');
  });
});
