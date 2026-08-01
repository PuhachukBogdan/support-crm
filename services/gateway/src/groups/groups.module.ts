import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { SecurityModule } from '../security/security.module';
import { GroupsController } from './groups.controller';

/**
 * Groups edge module (feature 024, roadmap 5.3 — ADR 0039). Imports `GrpcClientsModule` (AUTH_CLIENT)
 * and `SecurityModule` for the shared `EffectivePermsCache` — the same pair, for the same reason, as
 * the access-management edge: a privilege change at the edge must invalidate the cached answer.
 */
@Module({
  imports: [GrpcClientsModule, SecurityModule],
  controllers: [GroupsController],
})
export class GroupsEdgeModule {}
