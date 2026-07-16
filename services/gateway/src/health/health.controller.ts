import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ReadinessDto } from '@crm/common';
import { ReadinessService } from './readiness.service';

/**
 * Liveness contract (see specs/002-.../contracts/gateway-health.md).
 * A pure liveness signal — no dependency aggregation. Unauthenticated by design: probes
 * must not require a token. Readiness (dependency-aware) is the separate `/health/ready`.
 */
export interface HealthResponse {
  status: 'ok';
  service: 'gateway';
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  // Explicit @Inject — the service runtime (tsx/esbuild) emits no decorator metadata.
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'gateway',
      uptimeSeconds: process.uptime(),
    };
  }

  /**
   * Readiness aggregate (spec 003, US5). 200 when every dependency is healthy, 503 when any
   * is degraded — while always returning the per-dependency body so callers see WHICH is down.
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessDto> {
    const report = await this.readiness.getReadiness();
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
