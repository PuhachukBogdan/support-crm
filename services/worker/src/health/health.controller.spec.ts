import { HealthGrpcController } from './health.controller';
import type { RedisService } from '../queue/redis.service';

// US5 / FR-012: worker reports the real Redis state, never throws.
describe('worker HealthGrpcController', () => {
  it('SERVING when the redis probe resolves', async () => {
    const redis = { ping: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService;
    const res = await new HealthGrpcController(redis).check();
    expect(res.status).toBe('SERVING');
    expect(res.service).toBe('worker');
    expect(res.dependencies[0]).toMatchObject({ name: 'redis', status: 'SERVING' });
  });

  it('NOT_SERVING (never throws) when the redis probe rejects', async () => {
    const redis = {
      ping: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    } as unknown as RedisService;
    const res = await new HealthGrpcController(redis).check();
    expect(res.status).toBe('NOT_SERVING');
    expect(res.dependencies[0]!.status).toBe('NOT_SERVING');
  });
});
