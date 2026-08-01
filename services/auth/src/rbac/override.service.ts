import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { RoleDefaultsService } from './role-defaults.service';

type ScopedDb = ReturnType<PrismaService['forAccount']>;

export type OverrideOutcome =
  | { status: 'ok'; affectedUserIds: string[] }
  | { status: 'cross_role' }
  | { status: 'not_found' };

export interface ResetTarget {
  /** `group` is a LEGACY synonym for `selection` — see the banner on `personalizeSelection`. */
  scope: 'user' | 'selection' | 'role';
  userId?: string;
  userIds?: string[];
  roleKey?: string;
}

/** Who performed the change, and whether they were previewing another role at the time (feature 015). */
export interface Actor {
  userId: string;
  underPreview?: boolean;
}

/**
 * OverrideService (feature 011, T033 — US3). Copy-on-write personalization (R-2): the first per-user
 * edit SNAPSHOTS the role's current defaults into `UserPermissionEntry` and flips the user to
 * `standalone`; from then the user is an independent set (later role-template edits do not propagate).
 * Reset discards the snapshot → the user re-inherits the live role default. Group edits are constrained
 * to a SINGLE role (FR-011). Account-scoped (Principle I).
 *
 * ── Restructured by feature 015 (roadmap 4.8) ──────────────────────────────────────────────────────
 * Every mutation now does **all its reads first**, then performs its writes **and its audit entry** in a
 * single batch `$transaction`. Two things follow, and the second is why it was worth touching a working path:
 *
 *  1. The action and its audit entry succeed together (spec Q3 / FR-009). Before this, the audit row was
 *     written *after* the mutation and outside any transaction — so a failing audit left the permission
 *     change standing, unrecorded. That was best-effort **by accident**, not by decision.
 *  2. The mutation itself became atomic. It was previously a sequence of independent writes: a failure
 *     halfway left a user snapshotted-but-not-granted.
 *
 * The BATCH form of `$transaction` is used deliberately — feature 013's live-only defect was pulling
 * `$transaction` into a variable and losing its `this`, after which Prisma died on `_engineConfig`. Nothing
 * here needs a read *inside* the transaction, so the form that cannot have that bug is the one used.
 */
@Injectable()
export class OverrideService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(RoleDefaultsService) private readonly roleDefaults: RoleDefaultsService,
  ) {}

  async personalizeUser(
    accountId: string,
    actor: Actor,
    userId: string,
    permissionKey: string,
    grant: boolean,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);

    // ── reads ──
    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    if (!perm) return { status: 'not_found' };
    const role = await this.roleOf(db, userId);
    if (!role) return { status: 'not_found' };
    const standalone = await this.planStandalone(db, accountId, userId, role.id);

    // ── one transaction: snapshot (if needed) + the edit + the audit entry ──
    await db.$transaction([
      ...standalone,
      this.entryStatement(db, userId, perm.id, grant),
      this.audit.statement(accountId, {
        action: grant ? 'permission.grant' : 'permission.revoke',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: userId,
        detail: { scope: 'user', permissionKey, grant },
      }),
    ] as never);

    return { status: 'ok', affectedUserIds: [userId] };
  }

  /**
   * Apply one permission edit to a **hand-picked BATCH OF USERS** at once, constrained to a single
   * role (FR-011).
   *
   * ⚠️ **Renamed from `personalizeGroup` by feature 024, and the rename is the point.** "Group" here
   * never meant an entity — it meant "several users selected in the admin panel". Feature 024 then
   * introduced a real `Group`, and this project has already paid once for exactly this shape:
   * `Player.preferences_json` (a customer's VIP portfolio) collided with operator UI preferences in
   * feature 021, and the lesson recorded was that **"the name is taken" is what makes the next person
   * assume the thing is already built.**
   *
   * The WIRE name stays `PersonalizeGroup`, because renaming an rpc trips `buf breaking` — the same
   * wall `CheckBrandAccess` hit in feature 020. So the collision is declared in the proto rather than
   * removed, and everything that CAN be renamed has been. The real entity lives in
   * `services/auth/src/group/` and is **not** this.
   */
  async personalizeSelection(
    accountId: string,
    actor: Actor,
    userIds: string[],
    permissionKey: string,
    grant: boolean,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);

    // ── reads: the single-role constraint (FR-011) plus each user's snapshot plan ──
    const roleKeys = new Set<string>();
    const roles: Array<{ userId: string; roleId: string }> = [];
    for (const uid of userIds) {
      const role = await this.roleOf(db, uid);
      if (!role) return { status: 'not_found' };
      roleKeys.add(role.key);
      roles.push({ userId: uid, roleId: role.id });
    }
    if (roleKeys.size > 1) return { status: 'cross_role' };

    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    if (!perm) return { status: 'not_found' };

    const statements: unknown[] = [];
    for (const { userId, roleId } of roles) {
      statements.push(...(await this.planStandalone(db, accountId, userId, roleId)));
      statements.push(this.entryStatement(db, userId, perm.id, grant));
    }

    // ── one transaction for the whole group + one audit entry describing it ──
    // `affectedCount` rather than joining every id into `target_ref`: the old shape produced an unbounded
    // string that no index could serve and no reader could scan.
    statements.push(
      this.audit.statement(accountId, {
        action: grant ? 'permission.grant' : 'permission.revoke',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: userIds[0] ?? '',
        detail: { scope: 'selection', permissionKey, grant, affectedCount: userIds.length },
      }),
    );
    await db.$transaction(statements as never);

    return { status: 'ok', affectedUserIds: userIds };
  }

  async resetToDefault(
    accountId: string,
    actor: Actor,
    target: ResetTarget,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);

    if (target.scope === 'role') {
      const roleKey = target.roleKey ?? '';
      // The role reset's writes are planned by their owning service so they can join THIS transaction —
      // otherwise the audit entry could not be strict for this scope.
      const plan = await this.roleDefaults.planResetRole(accountId, roleKey);
      if (plan.status === 'not_found') return { status: 'not_found' };
      await db.$transaction([
        ...plan.statements,
        this.audit.statement(accountId, {
          action: 'permission.reset',
          actorUserId: actor.userId,
          underPreview: actor.underPreview,
          targetRef: roleKey,
          detail: { scope: 'role', roleKey, affectedCount: plan.affectedUserIds.length },
        }),
      ] as never);
      return { status: 'ok', affectedUserIds: plan.affectedUserIds };
    }

    const userIds = target.scope === 'user' ? [target.userId ?? ''] : target.userIds ?? [];
    const statements: unknown[] = [];
    for (const uid of userIds) {
      statements.push(db.userPermissionEntry.deleteMany({ where: { user_id: uid } }));
      statements.push(
        db.userPermissionSet.upsert({
          where: { user_id: uid },
          create: { user_id: uid, account_id: accountId, mode: 'inherited', snapshot_role_id: null },
          update: { mode: 'inherited', snapshot_role_id: null },
        }),
      );
    }
    statements.push(
      this.audit.statement(accountId, {
        action: 'permission.reset',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: userIds[0] ?? '',
        detail: { scope: target.scope, affectedCount: userIds.length },
      }),
    );
    await db.$transaction(statements as never);

    return { status: 'ok', affectedUserIds: userIds };
  }

  /** The grant/revoke write for one user. */
  private entryStatement(db: ScopedDb, userId: string, permissionId: string, grant: boolean): unknown {
    return grant
      ? db.userPermissionEntry.upsert({
          where: { user_id_permission_id: { user_id: userId, permission_id: permissionId } },
          create: { user_id: userId, permission_id: permissionId, granted: true },
          update: { granted: true },
        })
      : db.userPermissionEntry.deleteMany({
          where: { user_id: userId, permission_id: permissionId },
        });
  }

  /**
   * Plan the copy-on-write snapshot (R-2): the statements that snapshot the role's current defaults onto the
   * user and flip them to standalone — or an empty list when they already are.
   *
   * Split out of the old `ensureStandalone` by feature 015: it read and wrote in one go, which cannot sit
   * inside a batch transaction. The reads happen here, the writes are returned for the caller to compose.
   */
  private async planStandalone(
    db: ScopedDb,
    accountId: string,
    userId: string,
    roleId: string,
  ): Promise<unknown[]> {
    const set = await db.userPermissionSet.findUnique({ where: { user_id: userId } });
    if (set?.mode === 'standalone') return [];
    const rolePerms = await db.rolePermission.findMany({ where: { role_id: roleId } });
    return [
      ...rolePerms.map((rp) =>
        db.userPermissionEntry.upsert({
          where: { user_id_permission_id: { user_id: userId, permission_id: rp.permission_id } },
          create: { user_id: userId, permission_id: rp.permission_id, granted: true },
          update: {},
        }),
      ),
      db.userPermissionSet.upsert({
        where: { user_id: userId },
        create: { user_id: userId, account_id: accountId, mode: 'standalone', snapshot_role_id: roleId },
        update: { mode: 'standalone', snapshot_role_id: roleId },
      }),
    ];
  }

  private async roleOf(db: ScopedDb, userId: string): Promise<{ id: string; key: string } | null> {
    const rows = await db.userRole.findMany({ where: { user_id: userId }, include: { role: true } });
    const role = rows[0]?.role;
    return role ? { id: role.id, key: role.key } : null;
  }
}
