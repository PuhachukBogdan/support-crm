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

/** Metadata key marking a route exempt from the view-as read-only write-block (feature 011, US5). */
export const ALLOW_UNDER_PREVIEW_KEY = 'rbac:allow_under_preview';

/**
 * Mark a route that MAY run while a view-as preview is active (the view-as control endpoints
 * themselves — entering/exiting preview). The {@link PermissionGuard} skips the read-only
 * write-block for these AND resolves the caller's REAL permissions (never the previewed role), so
 * entering/exiting preview always checks the real `platform.view_as` (US5).
 */
export const AllowUnderPreview = () => SetMetadata(ALLOW_UNDER_PREVIEW_KEY, true);
