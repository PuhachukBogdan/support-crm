import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type Prisma } from '../prisma.service';
import { CLOCK, type Clock } from '../auth/ports/clock';

export type PrivilegeAction =
  | 'role_assign'
  | 'role_change'
  | 'role_revoke'
  | 'perm_grant'
  | 'perm_revoke'
  | 'reset';

/** Non-PII detail recorded with a privilege change (permission keys / scope only — never values). */
export interface PrivilegeDetail {
  scope?: 'user' | 'group' | 'role';
  permissionKey?: string;
  roleKey?: string;
  grant?: boolean;
}

/**
 * PrivilegeAuditService (feature 011, T036). Writes a `PrivilegeAudit` row for EVERY role/permission
 * mutation (FR-013; 0019/SEC-29). Records actor + action + target reference + non-PII detail — never
 * a secret or a field value (Principle IV). Uses the injectable clock (Track A determinism).
 */
@Injectable()
export class PrivilegeAuditService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(
    accountId: string,
    actorUserId: string,
    action: PrivilegeAction,
    targetRef: string,
    detail: PrivilegeDetail = {},
  ): Promise<void> {
    await this.prisma.forAccount(accountId).privilegeAudit.create({
      data: {
        account_id: accountId,
        actor_user_id: actorUserId,
        action,
        target_ref: targetRef,
        detail_json: detail as unknown as Prisma.InputJsonValue,
        created_at: this.clock.now(),
      },
    });
  }
}
