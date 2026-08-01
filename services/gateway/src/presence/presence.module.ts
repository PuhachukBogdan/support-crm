import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { SecurityModule } from '../security/security.module';
import { PresenceController } from './presence.controller';

/**
 * Presence edge module (feature 025, roadmap 5.9).
 *
 * `SecurityModule` is imported for the permission guard that `@RequiresPermission` needs — **not**
 * for `EffectivePermsCache`. Presence deliberately caches nothing (FR-032): a stale "available"
 * pushes a live customer at somebody who has gone home, which is a routing defect rather than a
 * freshness inconvenience. `presence.spec.ts` asserts the absence rather than trusting this comment.
 */
@Module({
  imports: [GrpcClientsModule, SecurityModule],
  controllers: [PresenceController],
})
export class PresenceEdgeModule {}
