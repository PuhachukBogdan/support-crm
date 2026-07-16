import { HealthGrpcController } from './health.controller';
import type { PrismaService } from '../prisma.service';

// US5 / FR-012, FR-013: reports the real Postgres state via SELECT 1, never throws, and
// never leaks connection details in `detail`. Compose-independent (mocked Prisma).
describe('users HealthGrpcController', () => {
  it('SERVING when the database probe resolves', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) } as unknown as PrismaService;
    const res = await new HealthGrpcController(prisma).check();
    expect(res.status).toBe('SERVING');
    expect(res.service).toBe('users');
    expect(res.dependencies[0]).toMatchObject({ name: 'postgres', status: 'SERVING' });
  });

  it('NOT_SERVING (never throws) when the database probe rejects, with a scrubbed detail', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:5432 password=SuperSecret')),
    } as unknown as PrismaService;
    const res = await new HealthGrpcController(prisma).check();
    expect(res.status).toBe('NOT_SERVING');
    expect(res.dependencies[0]!.status).toBe('NOT_SERVING');
    // detail must not carry the underlying error / credentials
    expect(res.dependencies[0]!.detail).not.toContain('SuperSecret');
    expect(res.dependencies[0]!.detail).not.toContain('5432');
  });
});
