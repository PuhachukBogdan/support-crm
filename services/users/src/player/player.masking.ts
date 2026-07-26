import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { allowedFields, canMassExportContacts } from '@crm/common';

/**
 * Anti-pitching contact-field masking (feature 011, US4 / T045 — SEC-AP1). Builds the player
 * response by ALLOW-LIST from the caller's role tier, so fields the role may not see are
 * **structurally absent** from the returned object — not nulled (FR-014). Pure + stateless; the
 * tier policy lives in `@crm/common` (`field-tiers`). Applied wherever a `Player` is serialized
 * (the `UsersReadService` handlers land in Phase 5 — this is the tested unit they call).
 *
 * Under a view-as preview the caller passes the PREVIEWED role's key (resolver marks it), so the
 * card is masked exactly as that role would see it (US5).
 */
export function maskPlayer<T extends Record<string, unknown>>(
  player: T,
  roleKey: string,
): Partial<T> {
  const allowed = allowedFields(roleKey);
  const out: Partial<T> = {};
  for (const key of Object.keys(player) as (keyof T & string)[]) {
    if (allowed.has(key)) out[key] = player[key];
  }
  return out;
}

/**
 * Mass-export gate (feature 011, US4 / T046 — FR-017 / SEC-AP2). A masked (linear, open-only) role
 * may not bulk-export contacts: throws PERMISSION_DENIED. Individual masked reads remain allowed +
 * audited; only the bulk path is blocked. Wired onto `ListPlayersByBrand` when it lands (Phase 5).
 */
export function assertCanMassExport(roleKey: string): void {
  if (!canMassExportContacts(roleKey)) {
    throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
  }
}
