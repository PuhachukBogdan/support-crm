import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { ReadinessService } from './readiness.service';
import type { RedisService } from '../redis/redis.service';

// US5 / FR-012, SC-005: all-serving → ok; a downed service/dependency → degraded and NAMED,
// bounded (no hang). Compose-independent (mocked gRPC clients + Redis).
type CheckImpl = () => unknown;

function grpc(check: CheckImpl): ClientGrpc {
  return { getService: () => ({ check }) } as unknown as ClientGrpc;
}

function serving(service: string, dep: 'postgres' | 'redis') {
  return () =>
    of({ status: 'SERVING', service, dependencies: [{ name: dep, status: 'SERVING', detail: '' }] });
}

function build(overrides: Partial<Record<string, CheckImpl>>, redisOk = true): ReadinessService {
  const svc = new ReadinessService(
    grpc(overrides.auth ?? serving('auth', 'postgres')),
    grpc(overrides.users ?? serving('users', 'postgres')),
    grpc(overrides.chats ?? serving('chats', 'postgres')),
    grpc(overrides.brands ?? serving('brands', 'postgres')),
    grpc(overrides.worker ?? serving('worker', 'redis')),
    {
      ping: redisOk
        ? jest.fn().mockResolvedValue(undefined)
        : jest.fn().mockRejectedValue(new Error('down')),
    } as unknown as RedisService,
  );
  svc.onModuleInit();
  return svc;
}

describe('gateway ReadinessService', () => {
  it('reports ok with a row per service + the gateway when everything is healthy', async () => {
    const report = await build({}).getReadiness('T');
    expect(report.status).toBe('ok');
    expect(report.checkedAt).toBe('T');
    expect(report.dependencies).toHaveLength(6); // 5 services + gateway
    expect(report.dependencies.map((d) => d.service).sort()).toEqual(
      ['auth', 'brands', 'chats', 'gateway', 'users', 'worker'].sort(),
    );
  });

  it('reports degraded and marks the unreachable service when a Check errors', async () => {
    const report = await build({ auth: () => throwError(() => new Error('down')) }).getReadiness('T');
    expect(report.status).toBe('degraded');
    const auth = report.dependencies.find((d) => d.service === 'auth');
    expect(auth).toMatchObject({ reachable: false, postgres: 'degraded' });
    // other services stay healthy/reachable
    expect(report.dependencies.find((d) => d.service === 'users')).toMatchObject({
      reachable: true,
      postgres: 'ok',
    });
  });

  it('reports a service degraded when its own dependency reports NOT_SERVING', async () => {
    const workerDown = () =>
      of({
        status: 'NOT_SERVING',
        service: 'worker',
        dependencies: [{ name: 'redis', status: 'NOT_SERVING', detail: 'unreachable' }],
      });
    const report = await build({ worker: workerDown }).getReadiness('T');
    expect(report.status).toBe('degraded');
    expect(report.dependencies.find((d) => d.service === 'worker')).toMatchObject({
      reachable: true,
      redis: 'degraded',
    });
  });

  it('reports degraded when the gateway’s own Redis is down', async () => {
    const report = await build({}, false).getReadiness('T');
    expect(report.status).toBe('degraded');
    expect(report.dependencies.find((d) => d.service === 'gateway')).toMatchObject({
      redis: 'degraded',
    });
  });
});
