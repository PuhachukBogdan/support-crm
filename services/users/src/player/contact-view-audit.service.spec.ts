import { ContactViewAuditService } from './contact-view-audit.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';

/**
 * Feature 011 US4 (T041 — SEC-AP3 / FR-016 / SC-007), updated by feature 015 (T044).
 *
 * A read surfacing a maskable tier writes ONE audit entry recording actor/target/tier — never the value. A
 * linear (open-only) read writes nothing. A failed write is NOT swallowed.
 *
 * What changed in 015: the row lands in the unified `AuditEntry` trail as `contact.reveal`, with the tier in
 * `detail_json`, instead of the separate `ContactViewAudit` table. The three guarantees above are unchanged —
 * keeping them is exactly what this spec is for, and the third is the reason feature 015 revised its own
 * write-failure decision instead of relaxing this path (spec Q3).
 */
function fakeAudit(createImpl: (args: unknown) => Promise<unknown>) {
  const create = jest.fn(createImpl);
  const prisma = {
    forAccount: () => ({ auditEntry: { create } }),
  } as unknown as PrismaService;
  return { repo: new AuditRepository(prisma), create };
}

describe('ContactViewAuditService', () => {
  it('writes one entry with the top surfaced tier and NO value (AM read)', async () => {
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);

    await svc.recordView('acc1', 'god-or-am', 'player-9', 'am');

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('contact.reveal');
    expect(arg.data.actor_user_id).toBe('god-or-am');
    expect(arg.data.target_ref).toBe('player-9');
    expect(arg.data.detail_json).toEqual({ tier: 'am_only' }); // most-sensitive tier AM surfaces
    // No field value anywhere in the row.
    expect(JSON.stringify(arg.data)).not.toMatch(/notes|phone|email|preferences/i);
  });

  it('records the REAL actor plus the preview marker, never the previewed role', async () => {
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordView('acc1', 'god', 'player-9', 'am', true);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.actor_user_id).toBe('god');
    expect(arg.data.under_preview).toBe(true);
  });

  it('writes nothing for a linear (open-only) read', async () => {
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordView('acc1', 'agent', 'player-9', 'support_agent');
    expect(create).not.toHaveBeenCalled();
  });

  // The guarantee that outranked feature 015's own first answer on write-failure policy: an unaudited PII
  // reveal is the harvesting vector SEC-AP3 exists to detect, not a lost statistic.
  it('does NOT swallow a write failure (a record must not be silently dropped)', async () => {
    const { repo } = fakeAudit(async () => {
      throw new Error('db down');
    });
    const svc = new ContactViewAuditService(repo);
    await expect(svc.recordView('acc1', 'am1', 'player-9', 'am')).rejects.toThrow('db down');
  });
});
