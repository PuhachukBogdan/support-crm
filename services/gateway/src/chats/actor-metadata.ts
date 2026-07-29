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
 * ⚠️ `x-actor-brands` was REMOVED by feature 020's cleanup (ADR 0038 §1). It was set only when the
 * caller's brand set was non-empty, and nothing ever populated that set — so through four phases the
 * header was never sent and no service ever filtered on it. It was an authorization input that could
 * not fire, in the one file every service trusts for actor context.
 *
 * There is one support department; a brand never decides who may see what. Brand remains part of a
 * PLAYER'S IDENTITY (feature 020) and a FILTER a caller may ask for — never a permission.
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
  // Only when there IS one. An absent key and the string 'false' must not be conflated by a reader, and
  // every reader in the product tests for the literal 'true'.
  if (resolved?.roleKey) md.set('x-actor-effective-role', resolved.roleKey);
  if (opts.preview || resolved?.isPreview) md.set('x-is-preview', 'true');
  return md;
}
