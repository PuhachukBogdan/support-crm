import { Inject, Injectable } from '@nestjs/common';
import { surfacedMaskableTiers, type FieldTier } from '@crm/common';
import { AuditRepository } from '../audit/audit.repository';

/** Sensitivity order — the audit row records the MOST sensitive tier a read surfaced. */
const TIER_RANK: Record<FieldTier, number> = { open: 0, operational: 1, am_only: 2, masked_pii: 3 };

/**
 * Contact-field-view audit (feature 011, US4 / T046 — SEC-AP3 / ADR 0019). Writes ONE audit entry per read
 * that surfaces a maskable tier (operational/am_only/masked_pii), recording actor + target + the most
 * sensitive tier accessed — NEVER the field value (Principle IV). A read that surfaces only `open` fields
 * (a linear role) writes nothing.
 *
 * ── Reshaped by feature 015 (roadmap 4.8) ──────────────────────────────────────────────────────────
 * The row now goes into the unified `AuditEntry` trail as `contact.reveal`, with the tier in `detail_json`,
 * replacing the separate `ContactViewAudit` table. One trail, one vocabulary, one read surface — the
 * fragmentation 4.8 exists to remove. The guarantee is unchanged: the tier NAME, never a value.
 *
 * ── The write is NOT swallowed, and that decision outranked ours ───────────────────────────────────
 * If the write fails, the caller sees the error. Feature 011 chose that in service of SEC-AP3 (a firm P1
 * whose purpose is detecting contact harvesting), and feature 015's first instinct was to relax data-access
 * recording to best-effort. Reading this code changed that decision: an unaudited PII reveal is the
 * harvesting vector itself, not a lost statistic, so relaxing it would have quietly weakened an existing
 * security posture inside the feature meant to strengthen it. Best-effort is reserved for the deferred
 * high-volume `record.open` class instead (spec Q1/Q3).
 *
 * Account-scoped write (Principle I). Under a view-as preview the actor is the REAL caller (God), never the
 * previewed role (feature 011 FR-021 / feature 015 FR-005).
 *
 * ⚠️ NO LIVE CALLER YET: the player-read gRPC handlers that call this are Phase 5 (roadmap 5.1). When they
 * land they must call THIS writer, not invent a second store — inventing one is exactly how feature 011
 * ended up with two audit tables.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class ContactViewAuditService {
  constructor(@Inject(AuditRepository) private readonly audit: AuditRepository) {}

  async recordView(
    accountId: string,
    actorUserId: string,
    playerId: string,
    roleKey: string,
    underPreview = false,
  ): Promise<void> {
    const surfaced = surfacedMaskableTiers(roleKey);
    if (surfaced.length === 0) return; // only `open` fields seen — nothing maskable to audit.

    const topTier = surfaced.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
    await this.audit.append(accountId, {
      action: 'contact.reveal',
      actorUserId,
      targetRef: playerId,
      underPreview,
      // Tier NAME only — never a value. The per-class allow-list in libs/common/audit/detail.ts is what
      // makes that structural rather than a convention observed here.
      detail: { tier: topTier },
    });
  }
}
