import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

// Phase 0: the gateway is the REST/WS edge. Only the liveness HealthModule is wired here;
// JWT validation, routing to services, and RBAC guards arrive in Phase 3.
@Module({
  imports: [HealthModule],
})
export class AppModule {}
