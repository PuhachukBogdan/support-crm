import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';
import { AuthModule } from './auth/auth.module';
import { RbacModule } from './rbac/rbac.module';

// Phase 1 (spec 003): the auth service is a gRPC microservice exposing HealthService.Check
// over its own Postgres. Phase 3 (feature 009) adds the AuthModule — the login/session engine
// (2-step login, JWT, refresh, lockout) over the same auth_db. Feature 011 adds the RbacModule —
// the effective-permission resolver on AuthService (RBAC model owner). Health is unaffected.
@Module({
  imports: [AuthModule, RbacModule],
  controllers: [HealthGrpcController],
  providers: [PrismaService],
})
export class AppModule {}
