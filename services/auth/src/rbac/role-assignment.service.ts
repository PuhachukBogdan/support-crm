import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import type { Actor } from './override.service';

export type AssignOutcome =
  | { status: 'ok'; affectedUserIds: string[] }
  | { status: 'super_admin_ui_forbidden' }
  | { status: 'not_found' };

/**
 * RoleAssignmentService (feature 011, T035 — US3). Assigns / changes / revokes a user's role. The
 * `super_admin` role is NEVER assignable here — it exists only via the server whitelist (0033/FR-018);
 * an attempt returns `super_admin_ui_forbidden`. Every change is audited (FR-013). Account-scoped.
 *
 * Restructured by feature 015: the role change and its audit entry commit in ONE batch transaction, so a
 * failing audit refuses the change instead of leaving it unrecorded (spec Q3 / FR-009).
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  async assignRole(
    accountId: string,
    actor: Actor,
    userId: string,
    roleKey: string,
    op: 'assign' | 'revoke',
  ): Promise<AssignOutcome> {
    if (roleKey === 'super_admin') return { status: 'super_admin_ui_forbidden' };
    const db = this.prisma.forAccount(accountId);

    // ── read ──
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return { status: 'not_found' };

    // ── one transaction: the role change + its audit entry ──
    const auditEntry = this.audit.statement(accountId, {
      action: op === 'revoke' ? 'role.revoke' : 'role.assign',
      actorUserId: actor.userId,
      underPreview: actor.underPreview,
      targetRef: userId,
      detail: { roleKey },
    });

    if (op === 'revoke') {
      await db.$transaction([
        db.userRole.deleteMany({ where: { user_id: userId, role_id: role.id } }),
        auditEntry,
      ] as never);
      return { status: 'ok', affectedUserIds: [userId] };
    }

    // assign / change: user carries exactly one role — replace any existing assignment.
    await db.$transaction([
      db.userRole.deleteMany({ where: { user_id: userId } }),
      db.userRole.create({ data: { user_id: userId, role_id: role.id } }),
      auditEntry,
    ] as never);
    return { status: 'ok', affectedUserIds: [userId] };
  }
}
