import { Metadata } from '@grpc/grpc-js';
import type { EffectivePermissions } from '@crm/common';
import type { RequestClaims } from '../auth/auth.guard';

/**
 * Build the caller-context gRPC metadata an owning service reads (feature 012, research R1/R3).
 *
 * Identity comes from the gateway's VALIDATED claims (never the body); the effective permission set is
 * the one the global `PermissionGuard` already resolved onto `req.effective`. Each owning service
 * re-checks `x-actor-permissions` independently (Principle II).
 *
 * Brand scope (R3): `x-actor-brands` is set ONLY when the caller's brand set is a non-empty array.
 * When brands are absent (Brands service, roadmap 5.2) the key is omitted and the service applies NO
 * brand filter — mirroring the guard, which also defers brand enforcement until `claims.brands` exists.
 *
 * ── Feature 018 (roadmap 5.1) added two headers, and one of them is a REPAIR ─────────────────────
 *
 * **`x-actor-effective-role`** — the role a caller is *acting as*. Under a view-as preview the auth
 * resolver deliberately returns the PREVIEWED role in `effective.roleKey`, and that is the value
 * anti-pitching field masking must use: masking is a function of the role, and masking a previewed
 * session as the owner's real role is the opposite of what view-as exists for.
 *
 * ⚠️ **`x-actor-role` is NOT that value and must not be used as one.** It carries `claims.roles[0]`,
 * i.e. who the caller *is*, and until feature 018 it was read by nothing anywhere in the product. It is
 * left exactly as it was rather than repurposed: silently changing a header's meaning from "who they
 * are" to "who they are acting as" leaves a future reader no way to know which was intended.
 *
 * **`x-is-preview`** — this is the repair. The parameter for it has existed since feature 012 and **no
 * route has ever passed it**, so every audit entry in the product has recorded `under_preview: false`
 * regardless of the truth, and `users`' own `assertNotPreview` on the upload path could never fire.
 * Passing the resolved `effective` object supplies both new headers at once, which is why the second
 * parameter now accepts it.
 *
 * The `string[]` form is still accepted so this change is additive at every existing call site: same
 * headers, same values, nothing to re-verify. Passing `effective` is what opts a route into the two new
 * ones.
 */
export function buildActorMetadata(
  claims: RequestClaims,
  effective: EffectivePermissions | string[] | undefined,
  opts: { preview?: boolean } = {},
): Metadata {
  const resolved = Array.isArray(effective) ? undefined : effective;
  const permissionKeys = Array.isArray(effective) ? effective : (effective?.permissionKeys ?? []);

  const md = new Metadata();
  md.set('x-actor-account-id', claims.accountId);
  md.set('x-actor-user-id', claims.userId);
  md.set('x-actor-role', claims.roles?.[0] ?? '');
  md.set('x-actor-permissions', permissionKeys.join(','));
  if (Array.isArray(claims.brands) && claims.brands.length > 0) {
    md.set('x-actor-brands', claims.brands.join(','));
  }
  // Only when there IS one. An absent key and the string 'false' must not be conflated by a reader, and
  // every reader in the product tests for the literal 'true'.
  if (resolved?.roleKey) md.set('x-actor-effective-role', resolved.roleKey);
  if (opts.preview || resolved?.isPreview) md.set('x-is-preview', 'true');
  return md;
}
