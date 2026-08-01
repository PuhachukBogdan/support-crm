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

// Phase 1 (spec 003): the auth service is a gRPC microservice exposing HealthService.Check
// over its own Postgres. Phase 3 (feature 009) adds the AuthModule — the login/session engine
// (2-step login, JWT, refresh, lockout) over the same auth_db. Feature 011 adds the RbacModule —
// the effective-permission resolver on AuthService (RBAC model owner). Health is unaffected.
@Module({
  imports: [AuthModule, RbacModule, GroupModule],
  controllers: [
    AuditReadController,HealthGrpcController],
  providers: [
    AuditRepository,
    AuditAccessGuard,PrismaService],
})
export class AppModule {}
