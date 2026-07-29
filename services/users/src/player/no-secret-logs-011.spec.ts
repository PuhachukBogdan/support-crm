import { maskPlayer } from './player.masking';
import { ContactViewAuditService } from './contact-view-audit.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';

/**
 * T051 (feature 011, Polish) — contact-field masking + the contact-view audit never leak a PII
 * value (Principle IV / FR-014 / FR-016 / FR-023 / SEC-26/AP3). A linear read omits the sensitive
 * fields (structurally absent); the audit row records only the tier NAME; captured console output
 * never contains a field value.
 */
describe('masking + contact-view audit leak no PII value (FR-014/016/023)', () => {
  const player = {
    player_id: 'p-9',
    created_at: new Date('2020-01-01'),
    vip: true,
    segment: 'gold',
    am_notes: 'SECRET whales on fridays',
    preferences: { channel: 'SECRET-telegram' },
    gr8_snapshot: { surname: 'SECRET-Ivanov', phone: 'SECRET-+123', email: 'SECRET@x.test' },
  };
  const SENSITIVE = [
    'SECRET whales on fridays',
    'SECRET-telegram',
    'SECRET-Ivanov',
    'SECRET-+123',
    'SECRET@x.test',
  ];

  it('a linear-role mask omits the sensitive fields (structurally absent, not nulled)', () => {
    const masked = maskPlayer(player, 'support_agent');
    expect(masked).not.toHaveProperty('am_notes');
    expect(masked).not.toHaveProperty('preferences');
    expect(masked).not.toHaveProperty('gr8_snapshot');
    expect(masked).not.toHaveProperty('segment'); // operational hidden from a linear role
    expect(masked.player_id).toBe('p-9');
    expect(JSON.stringify(masked)).not.toMatch(/SECRET/);
  });

  it('the audit row records the tier NAME only, and nothing leaks to the console', async () => {
    const rows: Record<string, unknown>[] = [];
    const prisma = {
      forAccount: () => ({
        // Feature 015: the row lands in the unified AuditEntry trail.
        auditEntry: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
        },
      }),
    } as unknown as PrismaService;
    const svc = new ContactViewAuditService(new AuditRepository(prisma));

    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const captured: string[] = [];
    const spies = sinks.map((s) =>
      jest.spyOn(console, s).mockImplementation((...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
      }),
    );
    try {
      await svc.recordView('acct-A', 'am-1', { brandId: 'brand-a', playerId: 'p-9' }, 'am');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(rows).toHaveLength(1);
    // Feature 015: the tier moved into detail_json — same guarantee, unified shape.
    expect(rows[0]!.detail_json).toEqual({ tier: 'am_only' });
    expect(rows[0]!.action).toBe('contact.reveal');
    for (const secret of SENSITIVE) expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(captured.join('\n')).not.toMatch(/SECRET/);
  });
});
