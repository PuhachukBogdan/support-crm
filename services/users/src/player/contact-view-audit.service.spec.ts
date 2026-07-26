import { ContactViewAuditService } from './contact-view-audit.service';
import type { PrismaService } from '../prisma.service';

/**
 * Feature 011 US4 (T041 — SEC-AP3 / FR-016 / SC-007). A read surfacing a maskable tier writes ONE
 * ContactViewAudit row recording the actor/target/tier — never the value. A linear (open-only) read
 * writes nothing. A failed write is NOT swallowed (an access record must not be silently dropped).
 */
function fakePrisma(createImpl: (args: unknown) => Promise<unknown>) {
  const create = jest.fn(createImpl);
  const prisma = {
    forAccount: () => ({ contactViewAudit: { create } }),
  } as unknown as PrismaService;
  return { prisma, create };
}

describe('ContactViewAuditService', () => {
  it('writes one row with the top surfaced tier and NO value (AM read)', async () => {
    const { prisma, create } = fakePrisma(async (a) => a);
    const svc = new ContactViewAuditService(prisma);

    await svc.recordView('acc1', 'god-or-am', 'player-9', 'am');

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.field_category).toBe('am_only'); // most-sensitive tier AM surfaces
    expect(arg.data.actor_user_id).toBe('god-or-am');
    expect(arg.data.player_id).toBe('player-9');
    // No field value anywhere in the row.
    expect(JSON.stringify(arg.data)).not.toMatch(/notes|phone|email|preferences/i);
  });

  it('writes nothing for a linear (open-only) read', async () => {
    const { prisma, create } = fakePrisma(async (a) => a);
    const svc = new ContactViewAuditService(prisma);
    await svc.recordView('acc1', 'agent', 'player-9', 'support_agent');
    expect(create).not.toHaveBeenCalled();
  });

  it('does NOT swallow a write failure (record must not be silently dropped)', async () => {
    const { prisma } = fakePrisma(async () => {
      throw new Error('db down');
    });
    const svc = new ContactViewAuditService(prisma);
    await expect(svc.recordView('acc1', 'am1', 'player-9', 'am')).rejects.toThrow('db down');
  });
});
