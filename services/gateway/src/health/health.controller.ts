import { Controller, Get } from '@nestjs/common';

/**
 * Liveness contract (see specs/002-.../contracts/gateway-health.md).
 * Phase 0: a pure liveness signal — no DB/Redis/downstream aggregation (that is Phase 1).
 * Unauthenticated by design: k8s liveness probes must not require a token.
 */
export interface HealthResponse {
  status: 'ok';
  service: 'gateway';
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'gateway',
      uptimeSeconds: process.uptime(),
    };
  }
}
