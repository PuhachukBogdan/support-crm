import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GrpcClientsModule } from '../grpc/clients.module';
import { RedisService } from '../redis/redis.service';
import { EffectivePermsCache } from './effective-perms.cache';
import { PermissionGuard } from './permission.guard';
import { ViewAsContext } from './view-as.context';
import { ViewAsController } from '../auth/view-as.controller';

/**
 * Gateway RBAC enforcement module (feature 011). Registers the {@link PermissionGuard} GLOBALLY
 * (APP_GUARD) so every `@RequiresPermission` route is checked server-side (Principle II). Imported
 * AFTER the AuthEdgeModule in AppModule so the AuthGuard (which sets `req.claims`) runs first.
 * The guard dials Auth's resolver via the existing AUTH_CLIENT and caches results in Redis (R-1).
 *
 * US5: also owns the view-as preview context + control endpoints. The controller lives under
 * `auth/` but is registered here so the global APP_GUARD is declared exactly once and the guard +
 * preview context share one Redis connection.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [ViewAsController],
  providers: [
    RedisService,
    EffectivePermsCache,
    ViewAsContext,
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  // Exported so the Access-Management edge (US3) reuses the SAME cache (single Redis connection) to
  // invalidate affected users after a mutation, and the SAME ViewAsContext so its super-admin gate is
  // preview-aware (US5 read-shaping — the Track-B finding fix).
  exports: [EffectivePermsCache, ViewAsContext],
})
export class SecurityModule {}
