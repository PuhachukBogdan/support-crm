import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { probeServing } from '@crm/common';
import type { HealthCheckResponse } from '@crm/proto';
import { RedisService } from '../queue/redis.service';

/**
 * gRPC `HealthService.Check` for the worker (spec 003, US5). Reports the only dependency
 * it owns — the shared Redis/queue store. Never throws (FR-012); no secrets/PII in detail.
 */
@Controller()
export class HealthGrpcController {
  // Explicit @Inject — tsx/esbuild emits no decorator metadata for type-based DI.
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  @GrpcMethod('HealthService', 'Check')
  async check(): Promise<HealthCheckResponse> {
    const redis = await probeServing(() => this.redis.ping());
    return {
      status: redis,
      service: 'worker',
      dependencies: [
        { name: 'redis', status: redis, detail: redis === 'SERVING' ? '' : 'unreachable' },
      ],
    };
  }
}
