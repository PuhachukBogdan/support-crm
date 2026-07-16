import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';

// Phase 1 (spec 003): the brands service is a gRPC microservice exposing HealthService.Check
// over its own Postgres. Brands domain logic (flows, JWT, RBAC) arrives in Phase 3.
@Module({
  controllers: [HealthGrpcController],
  providers: [PrismaService],
})
export class AppModule {}
