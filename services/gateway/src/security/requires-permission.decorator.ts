import { SetMetadata } from '@nestjs/common';

/** Metadata key naming the permission a route requires (feature 011, T017). */
export const REQUIRED_PERMISSION_KEY = 'rbac:required_permission';

/**
 * Declare the permission a route requires. The global {@link PermissionGuard} enforces it
 * server-side (Principle II) — a route with no `@RequiresPermission` is not permission-gated.
 *
 * @example
 *   @RequiresPermission('settings.manage')
 *   @Get('settings') …
 */
export const RequiresPermission = (permission: string) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

/** Metadata key naming a route param whose brand must be in the caller's brand scope (FR-004). */
export const REQUIRES_BRAND_PARAM_KEY = 'rbac:requires_brand_param';

/**
 * Declare that a route param identifies a brand the caller must have access to (brand/queue scope,
 * FR-004). Brand membership is read from the caller's claims; enforcement is in {@link PermissionGuard}.
 */
export const RequiresBrandParam = (param = 'brandId') =>
  SetMetadata(REQUIRES_BRAND_PARAM_KEY, param);

/**
 * Metadata key naming a route param whose UPLOAD PURPOSE determines the required permission
 * (feature 016).
 */
export const REQUIRES_PURPOSE_PARAM_KEY = 'rbac:requires_purpose_param';

/**
 * Declare that the permission this route requires is the one named by its upload purpose.
 *
 * ── Why `@RequiresPermission` could not express this ─────────────────────────────────────────────
 * That decorator takes a STATIC string, and here the key depends on the `:purpose` path parameter —
 * it is only known at request time. Annotating the upload route with a fixed key would be wrong for
 * every purpose but one, and annotating it with none would mean the gateway tier silently enforces
 * NOTHING while the service tier still does: the two-tier guarantee (Principle II) would be quietly
 * halved, and nothing would visibly break.
 *
 * The precedent is `@RequiresBrandParam`, which already reads a route param inside the guard.
 *
 * Resolution happens in {@link PermissionGuard}: an unknown purpose is refused, and a purpose whose
 * catalogue entry has `permission: null` means "authenticated is sufficient" — never "no check".
 *
 * @example
 *   @RequiresPurposePermission('purpose')
 *   @Post('uploads/:purpose') …
 */
export const RequiresPurposePermission = (param = 'purpose') =>
  SetMetadata(REQUIRES_PURPOSE_PARAM_KEY, param);

/**
 * Metadata key marking a route whose caller permissions must be RESOLVED and forwarded, even though
 * the gateway itself enforces no key (feature 016).
 */
export const RESOLVE_PERMISSIONS_KEY = 'rbac:resolve_permissions';

/**
 * Resolve the caller's effective permissions and attach them to the request, WITHOUT requiring any
 * particular key here. The owning service makes the authorization decision.
 *
 * ── Why this exists (found by feature-016 Track B, live) ─────────────────────────────────────────
 * `GET /uploads/:id` cannot name its required key: the key belongs to the upload's PURPOSE, which
 * lives in the stored row, not in the path. So the decision genuinely belongs to `users`. But the
 * gateway populates `req.effective` **only** when a route carries permission metadata — and
 * `buildActorMetadata` reads `req.effective` to fill `x-actor-permissions`. An un-annotated route
 * therefore forwarded an EMPTY permission set, and the owning service correctly refused every read.
 *
 * The failure was invisible to Track A by construction: the gateway guard and the service guard each
 * have thorough specs, and both were right. What was wrong was the WIRE between them, which only an
 * end-to-end request exercises. Hence this decorator is explicit rather than a quiet default —
 * "resolve but do not enforce" is a real, nameable position, and a route that silently forwards no
 * permissions is not.
 *
 * ⚠️ This is NOT "no authorization". The global AuthGuard still requires a session, and the owning
 * service still enforces the purpose's key on every single read (FR-010).
 */
export const ResolvesPermissions = () => SetMetadata(RESOLVE_PERMISSIONS_KEY, true);

/** Metadata key marking a route exempt from the view-as read-only write-block (feature 011, US5). */
export const ALLOW_UNDER_PREVIEW_KEY = 'rbac:allow_under_preview';

/**
 * Mark a route that MAY run while a view-as preview is active (the view-as control endpoints
 * themselves — entering/exiting preview). The {@link PermissionGuard} skips the read-only
 * write-block for these AND resolves the caller's REAL permissions (never the previewed role), so
 * entering/exiting preview always checks the real `platform.view_as` (US5).
 */
export const AllowUnderPreview = () => SetMetadata(ALLOW_UNDER_PREVIEW_KEY, true);
