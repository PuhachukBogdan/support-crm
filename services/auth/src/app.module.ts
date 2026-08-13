import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';
import { AuthModule } from './auth/auth.module';
import { RbacModule } from './rbac/rbac.module';
// Feature 024 (roadmap 5.3): the group entity. It lives in auth because both enforcement tiers
// consume ONE resolved permission set, produced here — see the banner in prisma/schema.prisma.
import { GroupModule } from './group/group.module';
// Feature 015 (roadmap 4.8): the audit trail — this service's source of the federated log.
import { AuditRepository } from './audit/audit.repository';
import { AuditReadController } from './audit/audit.grpc.controller';
import { AuditAccessGuard } from './audit/audit.guard';
// ⭐ W31 / feature 038 (roadmap 3.17, ADR 0043 §5): the provisioning key's own lifecycle. It lives
// beside the accounts it can mint, not at the edge — the channel precedent, applied to a credential
// one step more dangerous than a channel secret.
import { AuthAccessGuard } from './security/permission.guard';
import { ApiKeysRepository } from './api-keys/api-keys.repository';
import { ApiKeysService } from './api-keys/api-keys.service';
// ⭐ W31 / 038 (roadmap 3.15): the machine path — a stranger's key, never a session.
import { ProvisioningRepository } from './provisioning/provisioning.repository';
import { ProvisioningService } from './provisioning/provisioning.service';
import { ProvisioningController } from './provisioning/provisioning.grpc.controller';
import { StaffSweepController } from './provisioning/staff-sweep.grpc.controller';
import { ApiKeysGrpcController } from './api-keys/api-keys.grpc.controller';

// Phase 1 (spec 003): the auth service is a gRPC microservice exposing HealthService.Check
// over its own Postgres. Phase 3 (feature 009) adds the AuthModule — the login/session engine
// (2-step login, JWT, refresh, lockout) over the same auth_db. Feature 011 adds the RbacModule —
// the effective-permission resolver on AuthService (RBAC model owner). Health is unaffected.
@Module({
  imports: [AuthModule, RbacModule, GroupModule],
  controllers: [
    AuditReadController,
    ApiKeysGrpcController,
    // ⭐ W31 / 038: the ONE rpc pair a stranger's key can reach. No guard decorator on purpose —
    // there is no session to hold a permission; the authentication is the verification gate itself.
    ProvisioningController,
    // ⭐ W31: the offboarding sweep's first step. A maintenance surface — system actor, no route.
    StaffSweepController,
    HealthGrpcController],
  providers: [
    AuditRepository,
    AuditAccessGuard,
    AuthAccessGuard,
    ApiKeysRepository,
    ApiKeysService,
    ProvisioningRepository,
    ProvisioningService,
    PrismaService],
})
export class AppModule {}
