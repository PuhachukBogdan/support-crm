/**
 * The export-scope catalogue (feature 017, roadmap 4.10 — FR-003 / FR-025, research R1).
 *
 * ── Why a catalogue, again ───────────────────────────────────────────────────────────────────────
 * Fifth in the same family: the permission registry (011), the automation action vocabulary (014),
 * the audit action catalogue (015), the upload purposes (016) — and now this. Closed and additive:
 * an unknown scope resolves to NOTHING, because a permissive default is how a scope nobody reviewed
 * acquires a row limit nobody chose and a permission nobody granted.
 *
 * ── This file is the whole of FR-003 ─────────────────────────────────────────────────────────────
 * Adding an exportable thing means adding a ROW. No production code branches on a scope NAME, and
 * `tests/exports/scope-catalogue.spec.ts` asserts that as a scan rather than trusting it as taste.
 *
 * ── The one v1 row, and what is deliberately not in it ───────────────────────────────────────────
 * The operator scoped v1 to conversations (spec Q1 → A). Two later rows are already anticipated and
 * are NOT here, each for its own reason:
 *   • player / contact data — would carry contact fields, so it must route through the SEC-AP2 gate
 *     (see `mayContainContactData`). Until such a row exists, **SEC-AP2 stays open** — this feature
 *     does not close it and does not pretend to.
 *   • the audit log — a second consumer of 015's federated read, which is its own design question.
 *   • conversation MESSAGES — message bodies are the highest-PII payload in the product, so they
 *     arrive as a separate row with a separate permission key, never as a flag on this one (FR-004b).
 */

/** One exportable thing. Every field is a decision; none has a default. */
export interface ExportScope {
  /**
   * ONE permission key from the feature-011 catalogue — never null (unlike an upload purpose, where
   * "authenticated is sufficient" is meaningful), and never a list.
   *
   * The inbox-read permission is deliberately NOT a second key here. It applies inherently: the
   * producer runs through the existing conversation read path, which already enforces it, so a
   * requester who cannot list a conversation cannot export it. A second key would be a duplicate of
   * that check, kept in sync by hand (FR-025).
   */
  readonly permission: string;
  /**
   * Whether rows of this scope can carry player CONTACT fields.
   *
   * `false` for every v1 scope. A scope setting this `true` MUST consult `canMassExportContacts`
   * (`@crm/common/policy`) before any job is queued — SEC-AP2, enforced for every role including
   * admin and super_admin, since permission breadth never relaxes an invariant. The build fails if
   * such a scope exists without that gate, which is the point: the day someone adds contact data,
   * the guard is not something they have to remember.
   */
  readonly mayContainContactData: boolean;
  /** Refused above this — never truncated. A short file is a wrong answer that looks right. */
  readonly rowLimit: number;
  /** Refused above this, too. Bounded by the uploads channel ceiling (see the spec test). */
  readonly maxBytes: number;
  /** The single source of BOTH `expires_at` values — the export record's and the artefact's (R7). */
  readonly ttlSeconds: number;
  /** One format in v1. The audit entry reports it, so a second format cannot make old rows ambiguous. */
  readonly format: 'csv';
  /** Quota, counted per requester over a trailing window (FR-016) — see `export.quota.ts`. */
  readonly quotaMax: number;
  readonly quotaWindowSeconds: number;
}

const MB = 1024 * 1024;
const HOUR = 60 * 60;

/**
 * How long an export artefact lives — the SINGLE source of both expiries (research R7).
 *
 * Read here by the `conversations` scope (the export record's `expires_at`) and by the
 * `conversation_export` upload purpose (the artefact's own `expires_at`, the purge predicate). Two
 * derived copies of one constant, so the record and the bytes cannot disagree by code path.
 *
 * 24 h, chosen and recorded (spec FR-026): 1 h makes an end-of-shift request useless and pushes people to
 * re-export, putting MORE copies in storage; 7 d turns the bucket into a standing store of PII copies,
 * which is a retention decision this project has not made (SEC-25 is open).
 */
export const EXPORT_ARTEFACT_TTL_SECONDS = 24 * HOUR;

export const EXPORT_SCOPES = {
  /**
   * The inbox rows the requester can already list — CONVERSATION-LEVEL FIELDS ONLY.
   *
   * No message bodies, no private notes, no attachment references (FR-004b). That is not a
   * simplification for v1's convenience: it is why the SEC-13 private-note question does not arise
   * here at all. The payload cannot contain a note, so there is nothing to exclude and nothing to
   * get wrong. A `conversation_messages` scope would be a different row with a different key.
   *
   * 25 000 rows / 10 MB: whichever binds first REFUSES. 10 MB keeps the artefact inside the 12 MB
   * uploads channel that feature 016 already sized and tested, so this scope cannot be configured
   * into a transport failure.
   *
   * 24 h (spec FR-026, chosen by us and recorded): 1 h makes a request placed at the end of a shift
   * useless — which pushes people to re-export, putting MORE copies in storage. 7 d turns the bucket
   * into a standing store of PII copies, which is a retention decision this project has not made
   * (SEC-25 is open). 24 h covers "I'll download it tomorrow morning" inside one working cycle.
   */
  conversations: {
    permission: 'crm.exports.conversations',
    mayContainContactData: false,
    rowLimit: 25_000,
    maxBytes: 10 * MB,
    ttlSeconds: EXPORT_ARTEFACT_TTL_SECONDS,
    format: 'csv',
    quotaMax: 5,
    quotaWindowSeconds: HOUR,
  },
} as const satisfies Record<string, ExportScope>;

export type ExportScopeName = keyof typeof EXPORT_SCOPES;

/** Every registered scope name. The catalogue is closed: this is the complete set. */
export const EXPORT_SCOPE_NAMES = Object.keys(EXPORT_SCOPES) as ExportScopeName[];

/**
 * Whether `value` names a registered scope.
 *
 * `Object.prototype.hasOwnProperty` and not `value in EXPORT_SCOPES`: `'constructor' in obj` is true
 * for every object, so `in` would accept `constructor` as a scope name and hand the caller a
 * function where a row should be. The same trap 016's purpose lookup documents.
 */
export function isExportScope(value: string | undefined): value is ExportScopeName {
  return !!value && Object.prototype.hasOwnProperty.call(EXPORT_SCOPES, value);
}

/** The row for `value`, or `undefined`. `undefined` is a refusal, never "carry on with defaults". */
export function scopeOf(value: string | undefined): ExportScope | undefined {
  if (!isExportScope(value)) return undefined;
  return EXPORT_SCOPES[value];
}

/**
 * The terminal and non-terminal states an export can be in.
 *
 * `expired` is terminal and is NOT an error: it is the designed end of an artefact's life. A caller
 * seeing `expired` for their own export is being told the truth; a caller asking for someone else's
 * is told `NOT_FOUND`, which is the same answer as "never existed" (FR-011).
 */
export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const TERMINAL_EXPORT_STATUSES: readonly ExportStatus[] = ['ready', 'failed', 'expired'];

/**
 * The closed vocabulary of failure reasons.
 *
 * Codes, never messages: a raw error string is how a row value or a filter term reaches a place PII
 * must not be (SEC-26). `authority_revoked` is the R15 outcome — the requester no longer held the
 * scope's permission when production ran, so the export failed instead of producing a file with
 * authority nobody currently has.
 */
export const EXPORT_FAILURE_REASONS = [
  'row_limit_exceeded',
  'byte_limit_exceeded',
  'source_unavailable',
  'storage_unavailable',
  'interrupted',
  'authority_revoked',
] as const;
export type ExportFailureReason = (typeof EXPORT_FAILURE_REASONS)[number];
