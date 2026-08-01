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

    // ⭐ Feature 026: `true` = the caller is ATTACHED to this player. The tier an entry records is
    // now a property of the role AND this record, not of the role alone — an entry claiming an
    // unattached AM surfaced `am_only` would OVERSTATE a trail whose purpose is detecting over-reach.
    await svc.recordView('acc1', 'god-or-am', { brandId: 'brand-a', playerId: 'player-9' }, 'am', false, true);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('contact.reveal');
    expect(arg.data.actor_user_id).toBe('god-or-am');
    // Feature 020: the subject is the BRAND-SCOPED customer. `player-9` alone stopped naming a person
    // the moment the same platform id could belong to two people under two brands — an access trail
    // that cannot say WHICH customer was read is ambiguous exactly where it must not be.
    expect(arg.data.target_ref).toBe('brand-a/player-9');
    expect(arg.data.detail_json).toEqual({ tier: 'am_only' }); // most-sensitive tier AM surfaces
    // No field value anywhere in the row.
    expect(JSON.stringify(arg.data)).not.toMatch(/notes|phone|email|preferences/i);
  });

  it('records the REAL actor plus the preview marker, never the previewed role', async () => {
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordView('acc1', 'god', { brandId: 'brand-a', playerId: 'player-9' }, 'am', true);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.actor_user_id).toBe('god');
    expect(arg.data.under_preview).toBe(true);
  });

  it('writes nothing for a linear (open-only) read — a KNOWN, DOCUMENTED blind spot', async () => {
    /**
     * ⚠️ This is the one assertion in the file that pins a GAP rather than a guarantee, and feature 018
     * tried to remove it.
     *
     * The gap: a linear role's reads are invisible in the trail, which is the quiet-harvesting shape
     * SEC-AP3 exists to detect, one tier below where anyone was looking. Feature 018 implemented the fix
     * (`record.open`, best-effort) and reverted it, because `tests/audit/no-best-effort.spec.ts` refused
     * the change and was right to: feature 015 attached a PRECONDITION to that action — best-effort belongs
     * to that class *when it ships WITH a retention policy* — and retention (SEC-25) is still open.
     *
     * So this test says "still not closed", not "correct as is". When SEC-25 is answered, this is the
     * assertion that inverts.
     */
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordView('acc1', 'agent', { brandId: 'brand-a', playerId: 'player-9' }, 'support_agent');
    expect(create).not.toHaveBeenCalled();
  });

  it('*** the tier follows the CALLER CLEARANCE, not the record contents *** (feature 018)', async () => {
    // `surfacedMaskableTiers` takes a role and ignores the row, so an account manager reading a record
    // whose portfolio fields are all empty still records the portfolio tier. That is the right answer —
    // *what this person was entitled to look at* is the question an investigation asks — and it keeps the
    // entry stable while the record changes. Without this case the split reads as per-read, and a later
    // edit would "fix" it toward the record's contents.
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordView('acc1', 'am-1', { brandId: 'brand-a', playerId: 'player-empty' }, 'am', false, true);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.detail_json).toEqual({ tier: 'am_only' });
  });

  it('a BULK read writes ONE entry targeting the BRAND, with filter NAMES only (feature 018)', async () => {
    // Not one entry per record: a per-row trail over a paged list is useless to read and is the largest
    // available surface for leaking a value. Feature 017 made the same call for exports.
    const { repo, create } = fakeAudit(async (a) => a);
    const svc = new ContactViewAuditService(repo);
    await svc.recordBulkRead('acc1', 'am-1', 'brand-a', 'am', ['brandId']);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('contact.reveal');
    expect(arg.data.target_ref).toBe('brand-a'); // the brand, not a player
    expect(arg.data.detail_json).toEqual({ tier: 'am_only', filters: ['brandId'] });
    // A filter NAME is a field label; a filter VALUE would be tenant data.
    expect(JSON.stringify(arg.data)).not.toContain('player');
  });

  it('a bulk read does NOT swallow a write failure either', async () => {
    const { repo } = fakeAudit(async () => {
      throw new Error('db down');
    });
    const svc = new ContactViewAuditService(repo);
    await expect(svc.recordBulkRead('acc1', 'am-1', 'brand-a', 'am', ['brandId'])).rejects.toThrow('db down');
  });

  // The guarantee that outranked feature 015's own first answer on write-failure policy: an unaudited PII
  // reveal is the harvesting vector SEC-AP3 exists to detect, not a lost statistic.
  it('does NOT swallow a write failure (a record must not be silently dropped)', async () => {
    const { repo } = fakeAudit(async () => {
      throw new Error('db down');
    });
    const svc = new ContactViewAuditService(repo);
    await expect(
      svc.recordView('acc1', 'am1', { brandId: 'brand-a', playerId: 'player-9' }, 'am', false, true),
    ).rejects.toThrow('db down');
  });
});
