import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { probeServing } from '@crm/common';
import type { HealthCheckResponse } from '@crm/proto';
import { PrismaService } from '../prisma.service';

/**
 * gRPC `HealthService.Check` for the chats service (spec 003, US5). Reports the real state
 * of the ONLY dependency this service owns — its Postgres database — via `SELECT 1`.
 * Never throws: a downed DB is reported as NOT_SERVING (FR-012). No secrets/PII in `detail`.
 */
@Controller()
export class HealthGrpcController {
  // Explicit @Inject: the service runtime (tsx/esbuild) does not emit decorator metadata,
  // so type-based DI can't resolve this — the token must be explicit.
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @GrpcMethod('HealthService', 'Check')
  async check(): Promise<HealthCheckResponse> {
    const postgres = await probeServing(() => this.prisma.$queryRaw`SELECT 1`);
    return {
      status: postgres,
      service: 'chats',
      dependencies: [
        { name: 'postgres', status: postgres, detail: postgres === 'SERVING' ? '' : 'unreachable' },
      ],
    };
  }
}
