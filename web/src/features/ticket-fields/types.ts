/**
 * ⭐ W30 (спек №1, roadmap 4.15) — wire types for the fields/forms/option-sets authoring surface.
 *
 * Shapes mirror the gateway edge (`services/gateway/src/chats/field-config.controller.ts`) and are
 * restated here because `web/` deliberately imports nothing from the services' shared library (the
 * `RealtimeEvent` precedent in `data-access.ts`).
 *
 * ⚠️ Fields, forms and option sets are account DATA — no code anywhere branches on their keys
 * (`tests/fields/no-field-key-branch.spec.ts` scans all three trees). The TYPE vocabulary below is
 * the one closed list a renderer may branch on; canonical: `libs/common/src/fields/field-types.ts`.
 */

export const FIELD_TYPES = [
  { key: 'dropdown', label: 'Drop-down (values from an option set)', badge: 'drop-down' },
  { key: 'text', label: 'Single-line text', badge: 'text' },
  { key: 'numeric', label: 'Number', badge: 'number' },
  { key: 'multiline', label: 'Multi-line text', badge: 'multi-line' },
] as const;

export type FieldTypeKey = (typeof FIELD_TYPES)[number]['key'];

/** For a badge the wire's word is shown as-is when unknown — fail-open on DISPLAY only. */
export function fieldTypeBadge(type: string): string {
  return FIELD_TYPES.find((t) => t.key === type)?.badge ?? type;
}

// ── the one read projection (`admin-field-config`, a singleton) ───────────────────────────────────

export interface OptionValueWire {
  value: string;
  order: number;
  active: boolean;
}

export interface OptionSetWire {
  id: string;
  name: string;
  values: OptionValueWire[];
}

export interface FieldDefWire {
  id: string;
  key: string;
  label: string;
  /** From the closed vocabulary; typed open because the wire is the server's word. */
  type: string;
  required: boolean;
  restricted: boolean;
  /** Non-empty exactly when `type === 'dropdown'` (the server enforces the biconditional). */
  optionSetId: string;
  /** Empty = applies to every brand (per-brand applicability is data, rule 6). */
  brandIds: string[];
  active: boolean;
}

export interface FormEntryWire {
  fieldKey: string;
  order: number;
  /** Both empty = always shown; the parent must be a dropdown field of the same form. */
  conditionFieldKey: string;
  conditionValue: string;
  /** At most one per form, dropdown only — its value routes to the reserved sub-category column. */
  isSubcategorySource: boolean;
}

export interface FormWire {
  id: string;
  key: string;
  name: string;
  /** The topic this form files a conversation under; empty = leaves category untouched. */
  category: string;
  active: boolean;
  order: number;
  entries: FormEntryWire[];
}

export interface FieldConfigWire {
  optionSets: OptionSetWire[];
  fields: FieldDefWire[];
  forms: FormWire[];
}

// ── write payloads (POST creates — the key derives server-side; PATCH-by-key edits) ──────────────

export interface FieldBody {
  label: string;
  /** Sent whole on every PATCH too — the server refuses a CHANGED type, same type passes. */
  type: string;
  required: boolean;
  restricted: boolean;
  optionSetId: string;
  brandIds: string[];
  /** `false` on a PATCH is the archive; `true` the restore. */
  active: boolean;
}

export interface OptionSetBody {
  name: string;
  /** The WHOLE ordered list every time — the service diffs (a missing used value is refused). */
  values: OptionValueWire[];
}

export interface FormBody {
  name: string;
  category: string;
  active: boolean;
  order: number;
  /** The WHOLE entry list every time — a form save is atomic. */
  entries: FormEntryWire[];
}
