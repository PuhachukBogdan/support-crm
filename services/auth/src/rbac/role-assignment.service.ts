import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PrivilegeAuditService } from './privilege-audit.service';

export type AssignOutcome =
  | { status: 'ok'; affectedUserIds: string[] }
  | { status: 'super_admin_ui_forbidden' }
  | { status: 'not_found' };

/**
 * RoleAssignmentService (feature 011, T035 — US3). Assigns / changes / revokes a user's role. The
 * `super_admin` role is NEVER assignable here — it exists only via the server whitelist (0033/FR-018);
 * an attempt returns `super_admin_ui_forbidden`. Every change is audited (FR-013). Account-scoped.
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrivilegeAuditService) private readonly audit: PrivilegeAuditService,
  ) {}

  async assignRole(
    accountId: string,
    actorUserId: string,
    userId: string,
    roleKey: string,
    op: 'assign' | 'revoke',
  ): Promise<AssignOutcome> {
    if (roleKey === 'super_admin') return { status: 'super_admin_ui_forbidden' };
    const db = this.prisma.forAccount(accountId);

    if (op === 'revoke') {
      const role = await db.role.findFirst({ where: { key: roleKey } });
      if (!role) return { status: 'not_found' };
      await db.userRole.deleteMany({ where: { user_id: userId, role_id: role.id } });
      await this.audit.record(accountId, actorUserId, 'role_revoke', userId, { roleKey });
      return { status: 'ok', affectedUserIds: [userId] };
    }

    // assign / change: user carries exactly one role — replace any existing assignment.
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return { status: 'not_found' };
    await db.userRole.deleteMany({ where: { user_id: userId } });
    await db.userRole.create({ data: { user_id: userId, role_id: role.id } });
    await this.audit.record(accountId, actorUserId, 'role_assign', userId, { roleKey });
    return { status: 'ok', affectedUserIds: [userId] };
  }
}
