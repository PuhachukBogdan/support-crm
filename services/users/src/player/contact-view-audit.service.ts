import { Inject, Injectable } from '@nestjs/common';
import { surfacedMaskableTiers, surfacedMaskableTiersForRole, type FieldTier } from '@crm/common';
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
 * ── Feature 018 (roadmap 5.1): the handlers this was built for now EXIST, and are wired to it ─────
 * `UsersReadService.GetPlayer` / `ListPlayersByBrand` call this writer. It was built at feature 011 with a
 * comment saying the Phase-5 handlers must call THIS one rather than invent a second store; they do.
 *
 * Two things feature 018 added, and one it tried and reverted:
 *   • {@link recordBulkRead} — ONE entry for a whole paged list, targeting the BRAND rather than one entry
 *     per record. Same call feature 017 made for exports: a per-row trail over a paged list is useless to
 *     read and is the largest available surface for leaking a value.
 *   • The tier recorded follows the caller's CLEARANCE, not the record's contents — `surfacedMaskableTiers`
 *     takes a role and ignores the row, so an account manager reading a record whose portfolio fields are
 *     all null still records the portfolio tier. That is the right answer (*what this person was entitled
 *     to look at* is the question an investigation asks) and it keeps the entry stable while the record
 *     changes. Consequence worth stating: the access actions partition **by role**, not by read.
 *   • ⚠️ REVERTED: writing `record.open` for open-only reads. See the branch below.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class ContactViewAuditService {
  constructor(@Inject(AuditRepository) private readonly audit: AuditRepository) {}

  /**
   * ⚠️ Takes the full IDENTITY since feature 020, not a bare `playerId`.
   *
   * An entry reading "user X revealed contact fields of player 12345" stopped naming a customer the
   * moment the same platform id could belong to two people under two brands. The trail would have said
   * *someone was looked at* without saying *who* — ambiguous exactly where a trail has to be precise,
   * and unfixable afterwards because the missing part was never written down.
   */
  async recordView(
    accountId: string,
    actorUserId: string,
    subject: { brandId: string; playerId: string },
    roleKey: string,
    underPreview = false,
    /**
     * ⭐ Feature 026 (roadmap 5.7). Whether the caller is attached to THIS player.
     *
     * The note below used to say the recorded tier follows the caller's CLEARANCE rather than which
     * fields held a value — right while clearance was a property of the role alone. It is now a
     * property of the role AND this record, and an entry claiming an unattached AM surfaced
     * `am_only` would OVERSTATE a trail whose whole purpose is detecting over-reach. A trail that
     * overstates is worse than one that understates: its false entries look exactly like its true
     * ones.
     */
    attachedToSubject = false,
  ): Promise<void> {
    const surfaced = surfacedMaskableTiers(roleKey, { attachedToSubject });

    if (surfaced.length === 0) {
      /**
       * Only `open` fields — nothing maskable to audit, so nothing is written.
       *
       * ⚠️ THIS IS A KNOWN BLIND SPOT, and feature 018 deliberately did NOT close it. The reads of the
       * most numerous role are therefore invisible in the trail, which is one tier below where the
       * anti-harvesting finding was looking.
       *
       * Feature 018 implemented the fix (`record.open`, best-effort) and then reverted it, because
       * `tests/audit/no-best-effort.spec.ts` caught it: feature 015 attached a PRECONDITION to that
       * action — *"best-effort belongs to that class when it ships WITH a retention policy"* — and the
       * retention policy (SEC-25) is still open. `record.open` is the highest-volume entry class in the
       * product, so wiring it without one means unbounded growth in the table that records who looked at
       * customer data. That is a real cost, and 015 said decide it first rather than accept it.
       *
       * Closing this needs the retention decision, not more code. The mechanism is one branch here.
       */
      return;
    }

    const topTier = surfaced.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
    await this.audit.append(accountId, {
      action: 'contact.reveal',
      actorUserId,
      // The subject is the brand-scoped identity. The brand is not PII and not a value from the
      // record — it is which customer was read, which is the entry's whole job.
      targetRef: `${subject.brandId}/${subject.playerId}`,
      underPreview,
      // Tier NAME only — never a value. The per-class allow-list in libs/common/audit/detail.ts is what
      // makes that structural rather than a convention observed here.
      detail: { tier: topTier },
    });
  }

  /**
   * The bulk-list variant: **ONE** entry for the whole request, targeting the BRAND (feature 018).
   *
   * Not one per record, for the reason feature 017 recorded when it made the same call for exports: a
   * per-row trail over a paged list is useless to read and is the largest available surface for leaking a
   * value. The detail carries the filter **field names** — never their values — which the `access` class's
   * existing allow-list already permits, and that it needs no allow-list change is the evidence this shape
   * was anticipated rather than improvised.
   *
   * Strict, like the single-record reveal: a bulk list is only reachable by a cleared role, because a
   * role that may not bulk-read contacts is refused before any record is read.
   */
  async recordBulkRead(
    accountId: string,
    actorUserId: string,
    brandId: string,
    roleKey: string,
    filterFields: string[],
    underPreview = false,
  ): Promise<void> {
    // ⚠️ The ROLE-level answer, deliberately (feature 026). This entry names a BRAND, not a record,
    // so there is no single attachment to ask about — and the caller's clearance genuinely can
    // surface `am_only` for whichever rows in the page they are attached to. Narrowing here would
    // understate the trail, which is the opposite mistake and just as wrong.
    const surfaced = surfacedMaskableTiersForRole(roleKey);
    if (surfaced.length === 0) return; // unreachable: the guard refuses an open-only role first.

    const topTier = surfaced.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
    await this.audit.append(accountId, {
      action: 'contact.reveal',
      actorUserId,
      targetRef: brandId,
      underPreview,
      detail: { tier: topTier, filters: [...filterFields].sort() },
    });
  }
}
