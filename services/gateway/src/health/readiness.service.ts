import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable, timeout } from 'rxjs';
import {
  aggregateReadiness,
  probeServing,
  servingToState,
  type DependencyReport,
  type ReadinessDto,
  type ServingStatus,
} from '@crm/common';
import type { HealthCheckResponse } from '@crm/proto';
import {
  AUTH_HEALTH_CLIENT,
  BRANDS_HEALTH_CLIENT,
  CHATS_HEALTH_CLIENT,
  USERS_HEALTH_CLIENT,
  WORKER_HEALTH_CLIENT,
} from '../grpc/clients.module';
import { RedisService } from '../redis/redis.service';

interface HealthServiceClient {
  check(request: Record<string, never>): Observable<HealthCheckResponse>;
}

type Owned = 'postgres' | 'redis';

const CHECK_TIMEOUT_MS = 2000;

/**
 * Readiness aggregate (spec 003, US5 / FR-012). Fans `HealthService.Check` out to every
 * backend service with a bounded deadline, checks the gateway's own Redis, and composes a
 * single DTO naming any degraded dependency. Never hangs (timeout) or crashes (probes never
 * rethrow) on a downed dependency.
 */
@Injectable()
export class ReadinessService implements OnModuleInit {
  private readonly services: Array<{ name: string; owns: Owned; grpc: ClientGrpc }>;
  private clients: Array<{ name: string; owns: Owned; client: HealthServiceClient }> = [];

  constructor(
    @Inject(AUTH_HEALTH_CLIENT) auth: ClientGrpc,
    @Inject(USERS_HEALTH_CLIENT) users: ClientGrpc,
    @Inject(CHATS_HEALTH_CLIENT) chats: ClientGrpc,
    @Inject(BRANDS_HEALTH_CLIENT) brands: ClientGrpc,
    @Inject(WORKER_HEALTH_CLIENT) worker: ClientGrpc,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    this.services = [
      { name: 'auth', owns: 'postgres', grpc: auth },
      { name: 'users', owns: 'postgres', grpc: users },
      { name: 'chats', owns: 'postgres', grpc: chats },
      { name: 'brands', owns: 'postgres', grpc: brands },
      { name: 'worker', owns: 'redis', grpc: worker },
    ];
  }

  onModuleInit(): void {
    this.clients = this.services.map(({ name, owns, grpc }) => ({
      name,
      owns,
      client: grpc.getService<HealthServiceClient>('HealthService'),
    }));
  }

  async getReadiness(now: string = new Date().toISOString()): Promise<ReadinessDto> {
    const rows: DependencyReport[] = await Promise.all(
      this.clients.map(async ({ name, owns, client }) => {
        try {
          const res = await firstValueFrom(client.check({}).pipe(timeout(CHECK_TIMEOUT_MS)));
          const depStatus =
            (res.dependencies?.find((d) => d.name === owns)?.status as ServingStatus) ??
            (res.status as ServingStatus);
          const state = servingToState(depStatus ?? 'NOT_SERVING');
          return {
            service: res.service || name,
            postgres: owns === 'postgres' ? state : 'n/a',
            redis: owns === 'redis' ? state : 'n/a',
            reachable: true,
          };
        } catch {
          return {
            service: name,
            postgres: owns === 'postgres' ? 'degraded' : 'n/a',
            redis: owns === 'redis' ? 'degraded' : 'n/a',
            reachable: false,
          };
        }
      }),
    );

    // The gateway's own Redis reachability.
    const gatewayRedis = await probeServing(() => this.redis.ping());
    rows.push({
      service: 'gateway',
      postgres: 'n/a',
      redis: servingToState(gatewayRedis),
      reachable: true,
    });

    return aggregateReadiness(rows, now);
  }
}
