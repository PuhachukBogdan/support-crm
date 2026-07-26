import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RequestClaims } from './auth.guard';
import { ViewAsContext } from '../security/view-as.context';
import {
  AllowUnderPreview,
  RequiresPermission,
} from '../security/requires-permission.decorator';

/**
 * View-as-role preview control endpoints (feature 011, US5 — owner "God"). Entering the preview
 * requires the `platform.view_as` permission (super-admin default; the owner can revoke it from
 * other super-admins to become the sole holder — 0034). The global PermissionGuard enforces that
 * on `POST` (resolving the caller's REAL permissions, since these routes are `@AllowUnderPreview`),
 * then this controller stores the preview context. While a preview is active the guard shapes reads
 * to the previewed role and refuses every write (read-only, SC-009); these two control routes are
 * exempt so the caller can always enter/exit. Caller identity comes from validated claims only.
 */
@Controller('admin/view-as')
export class ViewAsController {
  constructor(@Inject(ViewAsContext) private readonly ctx: ViewAsContext) {}

  @Post()
  @RequiresPermission('platform.view_as')
  @AllowUnderPreview()
  async enter(
    @Body() body: { role?: string },
    @Req() req: Request & { claims?: RequestClaims },
  ): Promise<{ previewing: string }> {
    const claims = req.claims;
    if (!claims) throw new ForbiddenException();
    const role = (body?.role ?? '').trim();
    if (!role) throw new BadRequestException('role required');
    await this.ctx.set(claims.accountId, claims.userId, role);
    return { previewing: role };
  }

  @Delete()
  @AllowUnderPreview()
  async exit(
    @Req() req: Request & { claims?: RequestClaims },
  ): Promise<{ previewing: null }> {
    const claims = req.claims;
    if (!claims) throw new ForbiddenException();
    await this.ctx.clear(claims.accountId, claims.userId);
    return { previewing: null };
  }
}
