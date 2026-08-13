/**
 * The closed field-TYPE catalogue (feature 037, roadmap 4.15 — W30, spec №1).
 *
 * ── Two levels, and only one of them is code ─────────────────────────────────────────────────────
 * A **type** is what machine logic may branch on: how a value validates (free text, number text,
 * membership in an option set) and whether a definition must reference an option set. There are
 * four, the set is closed, and adding one is a deliberate edit here.
 *
 * A **field** is per-account CONFIGURATION and lives in `chats_db` — `key`, `label`, `type`,
 * `required`, `restricted`, `option_set_id`, `brand_ids`, `active`. Forms and option sets are rows
 * beside it. It is data precisely so the operator can add *PSP* or *Type of contact* without a
 * migration and without any code learning the word — the capture holds ~65 of these and the
 * roadmap forbids modelling them up front (4.15).
 *
 * ⚠️ **NO CODE BRANCHES ON A FIELD KEY OR A FORM KEY.** `tests/fields/no-field-key-branch.spec.ts`
 * asserts it as a scan, the statuses/channels discipline. Branching on a TYPE name is legitimate —
 * the type vocabulary is this file.
 *
 * ⚠️ **These are TICKET fields on `Conversation`** — never `Player.custom_attributes`, the
 * CUSTOMER's tiered portfolio data in users_db. One word, two unrelated stores; the confusion is
 * "the roadmap-4.15 failure shape" recorded in `services/users/prisma/schema.prisma`.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────────
 * The classification routing (form → `category`, designated entry → `sub_category`) is a property
 * of FORMS (per-account rows), not of types — a type cannot know it classifies. Widget/appearance
 * hints beyond `hasOptions` are also absent: the web renderer branches on the type name directly,
 * and a hint defined here today would have no second reader.
 *
 * Pure data + pure helpers. No I/O.
 */

export const FIELD_TYPE_KEYS = ['dropdown', 'text', 'numeric', 'multiline'] as const;

export type FieldType = (typeof FIELD_TYPE_KEYS)[number];

export interface FieldTypeSpec {
  /** One line a reader of the catalogue (not of the code) can understand. */
  label: string;
  /**
   * The definition MUST reference an option set (`true`) or MUST NOT (`false`) — the authoring
   * validator enforces the biconditional, and the value validator reads it to decide between
   * set-membership and shape checks. The one property both surfaces need; everything else about a
   * dropdown (its values, their order, their active flags) is account data on the set.
   */
  hasOptions: boolean;
}

export const FIELD_TYPES: Readonly<Record<FieldType, FieldTypeSpec>> = {
  dropdown: {
    label: 'Drop-down (values from an option set)',
    hasOptions: true,
  },
  text: {
    label: 'Single-line text',
    hasOptions: false,
  },
  numeric: {
    // Stored as its text form (data-model.md): a value column of one type keeps the store honest,
    // and the wire is strings throughout. The validator, not the column, refuses non-numbers.
    label: 'Number',
    hasOptions: false,
  },
  multiline: {
    label: 'Multi-line text',
    hasOptions: false,
  },
};

/** Fail-closed: an unknown value is refused, never defaulted (the 016/017 rule). */
export const isFieldType = (value: unknown): value is FieldType =>
  typeof value === 'string' && (FIELD_TYPE_KEYS as readonly string[]).includes(value);

/** Numeric acceptance: a finite number in plain notation. The single shape rule for `numeric`. */
export const isNumericFieldValue = (value: string): boolean =>
  value.trim() !== '' && Number.isFinite(Number(value));
