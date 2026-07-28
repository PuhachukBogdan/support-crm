import { BadRequestException } from '@nestjs/common';

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
 * The accepted keys are exactly the conversation list's filter vocabulary (FR-027), and
 * `tests/exports/filter-parity.spec.ts` asserts the two stay one vocabulary at the proto level.
 */
const ALLOWED_FILTERS = [
  'status',
  'priority',
  'assigneeOperatorId',
  'playerId',
  'brandId',
  'slaOutcome',
] as const;

/** The enums the list endpoint accepts. An unknown member is a 400, never a widened query. */
const STATUSES = ['open', 'pending', 'resolved', 'snoozed'] as const;
const SLA_OUTCOMES = ['pending', 'met', 'breached'] as const;

export interface ExportFiltersWire {
  status?: string;
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  brandId?: string;
  slaOutcome?: string;
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

  if (out.status && !(STATUSES as readonly string[]).includes(out.status)) {
    throw new BadRequestException('unknown status');
  }
  if (out.slaOutcome && !(SLA_OUTCOMES as readonly string[]).includes(out.slaOutcome)) {
    throw new BadRequestException('unknown slaOutcome');
  }
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
