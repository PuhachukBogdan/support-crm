import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { BrandReadController } from './brand/brand.grpc.controller';
import { PrismaService } from './prisma.service';

// Phase 1 (spec 003) gave this service a health probe over its own Postgres. Feature 020 (roadmap
// 5.2) gives it its actual job: the brand REGISTRY — name, slug and the badge an agent recognises.
// Not access control: one support department serves every brand, so a brand identifies a record and
// never gates it (ADR 0038 §1).
@Module({
  controllers: [HealthGrpcController, BrandReadController],
  providers: [PrismaService],
})
export class AppModule {}
