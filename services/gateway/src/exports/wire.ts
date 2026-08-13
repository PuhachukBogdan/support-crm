import { BadRequestException } from '@nestjs/common';
import { toChannelFilter, toSlaOutcomeWire, toStatusCategoryWire } from '../chats/wire';

/**
 * Fail-closed request parsing for the exports edge (feature 017 — FR-005/FR-027).
 *
 * ── Why an allow-list and not a pass-through ─────────────────────────────────────────────────────
 * Feature 012's Track B found the REST edge silently coercing an unrecognised `kind` into a PUBLIC
 * reply — a client typo published an intended private note to a customer. The lesson generalises: at a
 * REST edge, an unknown value must be REFUSED, never mapped to a default and never dropped. Dropping is
 * the dangerous one here, because a dropped filter WIDENS the result set: ask for one brand, get every
 * brand, in a file you then forward.
 *
 * ── ⚠️ FOUND ON TRACK B (2026-07-28): validating the vocabulary is not translating it ────────────
 * The first version of this file kept its OWN copy of the status and SLA vocabularies, validated the
 * caller's `open` against them, and forwarded the string unchanged. But `ExportFilters.status` is a
 * proto **enum**, so grpc-js coerced the unrecognised member `open` to the zero value
 * `CONVERSATION_STATUS_UNSPECIFIED` — silently. The export then filtered on UNSPECIFIED and produced an
 * **empty file that reported success**: a request for open conversations answered with a header row, an
 * audit entry saying `rowCount: 0`, and nothing anywhere indicating the filter had been discarded.
 *
 * That is feature 012's live defect again — an unknown enum member silently becoming the default — and
 * neither existing guard could see it. `filter-parity.spec.ts` compares the two proto messages by field
 * name, number and type, which were identical; this file's own tests asserted the human vocabulary was
 * validated, which it was. The gap was the TRANSLATION between them, which existed for the list and had
 * been duplicated-by-omission for the export.
 *
 * So the converters are now the list's own (`../chats/wire`). One translation, one place, one behaviour
 * — which is what FR-027's "the same filter vocabulary as the list endpoint" has to mean if it is to
 * mean anything: not the same words, the same code.
 */
const ALLOWED_FILTERS = [
  // ⭐ Feature 032 (roadmap 4.16): `status` is a status KEY (free-form, checked by the owning service
  // against the account's catalogue) and `statusCategory` is one of the closed six. The retired enum
  // filter is not accepted at all — see `../chats/wire.ts`.
  'status',
  'statusCategory',
  'priority',
  'assigneeOperatorId',
  'playerId',
  'brandId',
  'slaOutcome',
  // Feature 029: the Inbox can narrow by channel, so "export what I am looking at" must be able to as
  // well. Without it an admin who has filtered to one channel exports the WHOLE set — more customer
  // rows than the screen showed, which is the anti-pitching failure itself (SEC-AP2).
  'channel',
] as const;

export interface ExportFiltersWire {
  status?: string;
  statusKey?: string;
  statusCategory?: string;
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  brandId?: string;
  slaOutcome?: string;
  channel?: string;
}

export function parseExportFilters(body: unknown): ExportFiltersWire {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('filters must be an object');
  }

  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (k) => !(ALLOWED_FILTERS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    // The KEY names are echoed, never the values — a filter value can be a search term carrying PII
    // (SEC-26). Feature 015 took the same line on its audit filters.
    throw new BadRequestException(`unknown filter: ${unknown.sort().join(', ')}`);
  }

  const out: ExportFiltersWire = {};
  for (const key of ALLOWED_FILTERS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw new BadRequestException(`${key} must be a string`);
    out[key] = value;
  }

  /**
   * The enum fields are TRANSLATED here, by the list's own converters.
   *
   * They also validate: an unknown member is a 400 from inside `toStatusWire`, so this is not "validate
   * then translate" but one step that cannot be half-done. The previous version did the first half and
   * forwarded a value the wire could not represent — see the header.
   *
   * An ABSENT status becomes `CONVERSATION_STATUS_UNSPECIFIED`, which is what the list means by "no
   * status filter", and the chats controller drops it. That is the one case where UNSPECIFIED is a real
   * answer rather than a coercion.
   */
  /**
   * ⭐ Feature 032: `status` becomes `statusKey` and travels UNTRANSLATED.
   *
   * ⚠️ The header above describes a trap that no longer applies to this field, and the reason is worth
   * keeping straight: `status_key` is a proto STRING, so there is no enum member for grpc-js to coerce to
   * a zero value. The 017 defect it describes was specific to the enum, which this feature retired.
   * `statusCategory` IS still an enum, so it goes through the list's own converter — one translation,
   * one place, exactly as this file's header demands.
   */
  if (out.status !== undefined) {
    out.statusKey = out.status;
    delete out.status;
  }
  if (out.statusCategory !== undefined) out.statusCategory = toStatusCategoryWire(out.statusCategory);
  if (out.slaOutcome !== undefined) out.slaOutcome = toSlaOutcomeWire(out.slaOutcome);
  // Feature 029: `channel` is a plain proto string, not an enum, so there is no member to coerce — the
  // trap described in the header cannot occur here. It is still shape-checked by the list's own
  // converter, so the two edges refuse exactly the same values (FR-027: the same code, not the same words).
  if (out.channel !== undefined) out.channel = toChannelFilter(out.channel);
  return out;
}

/**
 * Page size for the export list.
 *
 * Absent ⇒ let the service apply its own default; nonsense ⇒ 400 rather than a silent fallback, because
 * `?pageSize=all` quietly becoming 50 teaches a client the wrong thing about the API. The server caps
 * the value regardless (Principle VII).
 */
export function parsePageSize(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('pageSize must be a positive integer');
  return n;
}
