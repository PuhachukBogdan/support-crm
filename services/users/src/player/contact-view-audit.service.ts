import { Inject, Injectable } from '@nestjs/common';
import { surfacedMaskableTiers, type FieldTier } from '@crm/common';
import { PrismaService } from '../prisma.service';

/** Sensitivity order — the audit row records the MOST sensitive tier a read surfaced. */
const TIER_RANK: Record<FieldTier, number> = { open: 0, operational: 1, am_only: 2, masked_pii: 3 };

/**
 * Contact-field-view audit (feature 011, US4 / T046 — SEC-AP3 / ADR 0019). Writes ONE
 * `ContactViewAudit` row per read that surfaces a maskable tier (operational/am_only/masked_pii),
 * recording actor + target + the most-sensitive tier accessed — NEVER the field value (Principle
 * IV / FR-016). A read that surfaces only `open` fields (a linear role) writes nothing.
 *
 * The write is NOT swallowed: if it fails, the caller sees the error (an access record must not be
 * silently dropped — spec edge case). Account-scoped write (Principle I). Under a view-as preview
 * the `actorUserId` is the REAL caller (God), never the impersonated role (FR-021).
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class ContactViewAuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async recordView(
    accountId: string,
    actorUserId: string,
    playerId: string,
    roleKey: string,
  ): Promise<void> {
    const surfaced = surfacedMaskableTiers(roleKey);
    if (surfaced.length === 0) return; // only `open` fields seen — nothing maskable to audit.

    const topTier = surfaced.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
    await this.prisma.forAccount(accountId).contactViewAudit.create({
      data: {
        account_id: accountId,
        actor_user_id: actorUserId,
        player_id: playerId,
        field_category: topTier, // tier NAME only — never a value (Principle IV).
      },
    });
  }
}
