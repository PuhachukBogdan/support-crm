import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { SecurityModule } from '../security/security.module';
import { AccessManagementController } from './access-management.controller';

/**
 * Access-Management edge module (feature 011, US2/US3 — ADR 0034). The super-admin admin-panel REST
 * over the Auth RBAC gRPC. Imports GrpcClientsModule (AUTH_CLIENT) and SecurityModule (the shared
 * EffectivePermsCache, for post-mutation invalidation). Thin proxy only (Principle VIII).
 */
@Module({
  imports: [GrpcClientsModule, SecurityModule],
  controllers: [AccessManagementController],
})
export class AccessManagementModule {}
