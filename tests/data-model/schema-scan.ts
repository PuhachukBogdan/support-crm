/**
 * Structural scan harness for the four per-service Prisma schemas (feature 006).
 *
 * The schema files are read as TEXT (never generated/imported) so the structural tests
 * are Docker-independent (Track A) and assert design invariants directly on the source:
 *   - account-scope coverage (Principle I)      -> account-scope.spec.ts
 *   - no relation crosses a schema (Principle VIII) -> no-cross-service-fk.spec.ts
 *   - reserved classification fields (ADR 0027)  -> reserved-fields.spec.ts
 *   - hot-column indexing (Principle VII)        -> indexes.spec.ts
 *   - Player-lite + opaque GR8 seam (ADR 0032)   -> player-lite.spec.ts
 *
 * This is a helper module, not a spec — it deliberately has no `.spec`/`.test` suffix so
 * Jest never runs it as a test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The four data-owning services, each with its own schema + database. */
export const SERVICES = ['auth', 'users', 'brands', 'chats'] as const;
export type Service = (typeof SERVICES)[number];

/** Prisma scalar types — anything else (capitalized) referencing a model is a relation. */
const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

export interface Field {
  /** Field name as written (snake_case in our schemas). */
  name: string;
  /** Base type with `?`/`[]` stripped, e.g. `String`, `Player`. */
  baseType: string;
  /** Full type token as written, e.g. `String?`, `PlayerBrand[]`. */
  rawType: string;
  optional: boolean;
  list: boolean;
  /** Everything after the type on the line (inline attributes). */
  attributes: string;
  /** A relation to another model (base type is a model, not a scalar/enum). */
  isRelation: boolean;
}

export interface IndexDecl {
  /** `id` (from `@@id`), `unique` (`@@unique`/inline `@unique`/`@id`), or `index` (`@@index`). */
  kind: 'id' | 'unique' | 'index';
  /** Ordered column names participating in the index. */
  columns: string[];
}

export interface Model {
  service: Service;
  name: string;
  fields: Field[];
  /** All indexes: block-level (`@@id`/`@@unique`/`@@index`) + inline (`@id`/`@unique`). */
  indexes: IndexDecl[];
  /** Pure join edge: a composite `@@id([...])` and no field-level `@id`. */
  isJoinTable: boolean;
  raw: string;
}

function schemaPath(service: Service): string {
  return resolve(__dirname, '..', '..', 'services', service, 'prisma', 'schema.prisma');
}

export function readSchema(service: Service): string {
  return readFileSync(schemaPath(service), 'utf8');
}

function parseType(token: string): { baseType: string; optional: boolean; list: boolean } {
  const optional = token.endsWith('?');
  const list = token.endsWith('[]');
  const baseType = token.replace(/[?[\]]/g, '');
  return { baseType, optional, list };
}

/** Extract the column list from a `@@id([...])` / `@@unique([...])` / `@@index([...])`. */
function parseColumnList(inner: string): string[] {
  return inner
    .split(',')
    .map((c) => c.trim())
    // `@@index([account_id(sort: Desc)])` etc. — keep the bare column name.
    .map((c) => c.replace(/\(.*$/, '').trim())
    .filter(Boolean);
}

export function parseModel(service: Service, name: string, body: string): Model {
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);

  const fields: Field[] = [];
  const indexes: IndexDecl[] = [];
  let hasFieldLevelId = false;
  let hasBlockId = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = /^@@(id|unique|index)\s*\(\s*\[([^\]]*)\]/.exec(line);
      if (m) {
        const kind = m[1] as IndexDecl['kind'];
        indexes.push({ kind, columns: parseColumnList(m[2]!) });
        if (kind === 'id') hasBlockId = true;
      }
      continue;
    }
    // Field line: `<name> <type> <attrs...>`
    const fm = /^(\w+)\s+([A-Za-z0-9_]+(?:\[\])?\??)\s*(.*)$/.exec(line);
    if (!fm) continue;
    const fieldName = fm[1]!;
    const rawType = fm[2]!;
    const attributes = (fm[3] ?? '').trim();
    const { baseType, optional, list } = parseType(rawType);
    const isRelation = !SCALARS.has(baseType) && /^[A-Z]/.test(baseType);

    // Inline single-column indexes.
    if (/(^|\s)@id(\s|$|\()/.test(attributes)) {
      indexes.push({ kind: 'id', columns: [fieldName] });
      hasFieldLevelId = true;
    }
    if (/(^|\s)@unique(\s|$|\()/.test(attributes)) {
      indexes.push({ kind: 'unique', columns: [fieldName] });
    }

    fields.push({ name: fieldName, baseType, rawType, optional, list, attributes, isRelation });
  }

  return {
    service,
    name,
    fields,
    indexes,
    isJoinTable: hasBlockId && !hasFieldLevelId,
    raw: body,
  };
}

/** Parse every `model {}` block in one service's schema. */
export function parseSchema(service: Service): Model[] {
  const text = readSchema(service);
  const models: Model[] = [];
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    models.push(parseModel(service, m[1]!, m[2]!));
  }
  return models;
}

/** All models across all four schemas. */
export function allModels(): Model[] {
  return SERVICES.flatMap((s) => parseSchema(s));
}

/** Names of models declared in a given service (for cross-schema relation checks). */
export function modelNames(service: Service): Set<string> {
  return new Set(parseSchema(service).map((m) => m.name));
}

/** Does any index cover this exact column (in any position)? */
export function columnIsIndexed(model: Model, column: string): boolean {
  return model.indexes.some((idx) => idx.columns.includes(column));
}

/** Does the model declare a scalar field with this name? */
export function hasField(model: Model, name: string): boolean {
  return model.fields.some((f) => f.name === name);
}

export function getField(model: Model, name: string): Field | undefined {
  return model.fields.find((f) => f.name === name);
}
