import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import type { Actor } from '../rbac/override.service';

type ScopedDb = ReturnType<PrismaService['forAccount']>;

/**
 * GroupService (feature 024, roadmap 5.3 — ADR 0039). The group ENTITY: create / rename / delete,
 * membership, and the permission grants a group confers.
 *
 * ⚠️ NOT `OverrideService.personalizeSelection`, which edits a hand-picked BATCH OF USERS at once and
 * unfortunately owned the word "group" first (its wire name `PersonalizeGroup` is kept because
 * renaming an rpc trips `buf breaking`). Nothing here has anything to do with that path. See
 * `tests/naming/personalize-group-disambiguated.spec.ts`.
 *
 * ── Where the authorization actually happens ────────────────────────────────────────────────────
 * Nowhere in this file. A group CONTRIBUTES grants into the one policy layer through
 * `RbacResolverService.resolve` (ADR 0039 §2); it gets no check of its own, because two mechanisms
 * that both decide access will diverge and the divergence is invisible until someone sees something
 * they should not. What this service does is own the DATA that the resolver reads.
 *
 * ── One transaction per act, audit entry included ───────────────────────────────────────────────
 * Same shape as `OverrideService`, for the same reason (feature 015 / spec Q3): all reads first, then
 * a single BATCH `$transaction` carrying the writes AND the audit entry, so an act and its record
 * succeed or fail together. The batch form is used deliberately — nothing here needs a read *inside*
 * the transaction, so the form that cannot lose `this` on `$transaction` is the one used (feature
 * 013's live-only defect).
 *
 * ── `affectedUserIds` is part of the answer, not a detail ───────────────────────────────────────
 * The gateway invalidates each affected user's cached effective permissions (feature 011, R-1). For a
 * grant change or a delete that is EVERY CURRENT MEMBER, read inside the same transaction: a stale
 * grant after a revocation is a live authorization defect, not a freshness nuisance.
 */

export type GroupOutcome =
  | { status: 'ok'; affectedUserIds: string[]; groupId: string }
  | { status: 'not_found' }
  | { status: 'name_taken' }
  | { status: 'invalid_name' }
  | { status: 'unknown_permission' }
  /** The caller may manage groups but does not hold the key they are trying to confer (FR-015). */
  | { status: 'escalation' };

export interface GroupView {
  id: string;
  name: string;
  active: boolean;
  memberCount: number;
  permissionKeys: string[];
}

/**
 * A bound rather than a policy: long enough for any real unit name, short enough that the column is
 * not a place to paste a paragraph. Enforced here so the caller gets a named refusal instead of a
 * database error surfacing as a 500.
 */
export const MAX_GROUP_NAME_LENGTH = 256;

/** Postgres unique-violation. The read-then-write check below can still lose a race; this catches it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

@Injectable()
export class GroupService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────

  async list(accountId: string): Promise<GroupView[]> {
    const db = this.prisma.forAccount(accountId);
    const groups = await db.group.findMany({ orderBy: { name: 'asc' } });
    const out: GroupView[] = [];
    for (const g of groups) {
      out.push({
        id: g.id,
        name: g.name,
        active: g.active,
        memberCount: (await db.groupMember.findMany({ where: { group_id: g.id } })).length,
        permissionKeys: await this.keysOf(db, g.id),
      });
    }
    return out;
  }

  /**
   * The membership list, as AUTH user ids. Used by the administration read and — through chats — as
   * the routing candidate pool.
   *
   * `null` means the group does not exist **in this account**; an empty array means it exists and has
   * nobody. The caller must be able to tell those apart: one is a mistake, the other is a fact, and
   * collapsing them is how "nobody is available" becomes indistinguishable from "I could not find out".
   */
  async listMembers(accountId: string, groupId: string): Promise<string[] | null> {
    const db = this.prisma.forAccount(accountId);
    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return null;
    const rows = await db.groupMember.findMany({ where: { group_id: groupId } });
    return rows.map((r) => r.user_id);
  }

  /** ⭐ W29 — the INVERSE read: which groups is this user in. The same indexed `GroupMember` lookup
   *  the resolver has run since 024, exposed for macro availability («кому доступен»). */
  async groupsOf(accountId: string, userId: string): Promise<string[]> {
    const rows = await this.prisma
      .forAccount(accountId)
      .groupMember.findMany({ where: { user_id: userId } });
    return rows.map((r) => r.group_id);
  }

  // ── mutations ───────────────────────────────────────────────────────────────────────────────────

  async create(accountId: string, actor: Actor, rawName: string): Promise<GroupOutcome> {
    const name = normaliseName(rawName);
    if (name === null) return { status: 'invalid_name' };
    const db = this.prisma.forAccount(accountId);

    if (await db.group.findFirst({ where: { name } })) return { status: 'name_taken' };

    try {
      const group = await db.group.create({ data: { account_id: accountId, name } });
      await db.$transaction([
        this.audit.statement(accountId, {
          action: 'group.create',
          actorUserId: actor.userId,
          underPreview: actor.underPreview,
          targetRef: group.id,
          detail: { scope: 'group' },
        }),
      ] as never);
      // Nobody's effective set changed: a brand-new group has no members and no grants.
      return { status: 'ok', affectedUserIds: [], groupId: group.id };
    } catch (err) {
      if (isUniqueViolation(err)) return { status: 'name_taken' };
      throw err;
    }
  }

  async rename(
    accountId: string,
    actor: Actor,
    groupId: string,
    rawName: string,
  ): Promise<GroupOutcome> {
    const name = normaliseName(rawName);
    if (name === null) return { status: 'invalid_name' };
    const db = this.prisma.forAccount(accountId);

    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return { status: 'not_found' };
    const clash = await db.group.findFirst({ where: { name } });
    if (clash && clash.id !== groupId) return { status: 'name_taken' };

    try {
      await db.$transaction([
        db.group.update({ where: { id: groupId }, data: { name } }),
        this.audit.statement(accountId, {
          action: 'group.rename',
          actorUserId: actor.userId,
          underPreview: actor.underPreview,
          targetRef: groupId,
          detail: { scope: 'group' },
        }),
      ] as never);
    } catch (err) {
      if (isUniqueViolation(err)) return { status: 'name_taken' };
      throw err;
    }
    // A name is not an authorization input — nothing branches on one (ADR 0039 §9), so no cache
    // anywhere holds a decision that a rename could invalidate.
    return { status: 'ok', affectedUserIds: [], groupId };
  }

  /**
   * ⭐ Feature 031 (ADR 0042) — switch a desk into or out of **automatic distribution**.
   *
   * ⚠️ **This is not a cosmetic flag.** Marking a desk routable means the router may hand its members a
   * customer conversation without anybody choosing — so it is audited under its own action rather than
   * folded into `group.rename`, whose subject is a label nothing branches on (ADR 0039 §9).
   *
   * ⚠️ **A no-op still writes an entry, and that is the project's convention rather than my preference.**
   * `group.audit.spec.ts` states it for the other seven group mutations: adding somebody who is already a
   * member changes no row, but *an administrator still ACTED* — which is why feature 015 deliberately left
   * the audit table without a unique constraint (*"a retry is a NEW act by the operator and deserves its
   * own entry"*). My first version skipped the entry when the value was unchanged, reasoning that no-op
   * flips would bury the moment that mattered. That would have been a **second philosophy about audit
   * no-ops** living beside the first, which is worse than a slightly noisier trail.
   *
   * The entry is written in the SAME transaction as the update, so "the desk started receiving pushed work
   * and nobody knows when" is unrepresentable.
   *
   * ⓘ Nothing to invalidate: the router reads this row per decision, and adding a cache here would let a
   * desk keep receiving work after being switched off — the failure that looks like a UI lag and is not.
   */
  /**
   * Is this desk fed by automatic distribution?
   *
   * ⚠️ Read per decision, never cached. A cached answer would let a desk keep receiving pushed work after
   * an administrator switched it off — a failure that looks like a slow UI and is not one.
   */
  async isRoutable(accountId: string, groupId: string): Promise<boolean> {
    const group = await this.prisma
      .forAccount(accountId)
      .group.findFirst({ where: { id: groupId }, select: { routable: true } });
    // An absent desk is not routable. Fail-closed, and the same answer the column's default gives.
    return group?.routable === true;
  }

  async setRoutable(
    accountId: string,
    actor: Actor,
    groupId: string,
    routable: boolean,
  ): Promise<GroupOutcome> {
    const db = this.prisma.forAccount(accountId);

    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return { status: 'not_found' };

    // Unchanged value: the update is a no-op and the ENTRY IS STILL WRITTEN — see the note above.
    await db.$transaction([
      db.group.update({ where: { id: groupId }, data: { routable } }),
      this.audit.statement(accountId, {
        action: 'group.routability_changed',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: groupId,
        /**
         * ⚠️ `grant`, not a new key. The `privilege` class allows `scope | permissionKey | roleKey | grant`,
         * and the allow-list is deliberately narrow — widening it for one action would make "no PII here"
         * a slightly weaker property for every action in the class. Enabling routability **is** a grant:
         * the desk gains the ability to receive customer conversations it did not have.
         */
        detail: { scope: 'group', grant: routable },
      }),
    ] as never);

    return { status: 'ok', affectedUserIds: [], groupId };
  }

  async remove(accountId: string, actor: Actor, groupId: string): Promise<GroupOutcome> {
    const db = this.prisma.forAccount(accountId);

    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return { status: 'not_found' };
    // Read the membership BEFORE the delete cascades it away: these are the people whose effective
    // permissions change, and after the delete there is nobody left to ask.
    const members = (await db.groupMember.findMany({ where: { group_id: groupId } })).map(
      (m) => m.user_id,
    );

    await db.$transaction([
      db.group.delete({ where: { id: groupId } }),
      this.audit.statement(accountId, {
        action: 'group.delete',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: groupId,
        detail: { scope: 'group', affectedCount: members.length },
      }),
    ] as never);

    return { status: 'ok', affectedUserIds: members, groupId };
  }

  async addMember(
    accountId: string,
    actor: Actor,
    groupId: string,
    userId: string,
  ): Promise<GroupOutcome> {
    return this.member(accountId, actor, groupId, userId, true);
  }

  async removeMember(
    accountId: string,
    actor: Actor,
    groupId: string,
    userId: string,
  ): Promise<GroupOutcome> {
    return this.member(accountId, actor, groupId, userId, false);
  }

  /**
   * Add or remove one membership.
   *
   * Idempotent on the DATA by primary key — adding an existing member cannot create a second row, and
   * removing an absent one deletes nothing. It is deliberately NOT idempotent on the TRAIL: an
   * administrator still performed an act, and feature 015 left the audit table without a unique
   * constraint for exactly this reason ("two grant attempts, one failed, is exactly what a reviewer
   * needs to see"). So the entry is written either way — exactly one per accepted request.
   */
  private async member(
    accountId: string,
    actor: Actor,
    groupId: string,
    userId: string,
    add: boolean,
  ): Promise<GroupOutcome> {
    const db = this.prisma.forAccount(accountId);

    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return { status: 'not_found' };
    // Account-scoped: a user from another account is simply not found here, so a membership can never
    // cross the tenancy wall (Principle I).
    const user = await db.user.findFirst({ where: { id: userId } });
    if (!user) return { status: 'not_found' };

    const write = add
      ? db.groupMember.upsert({
          where: { group_id_user_id: { group_id: groupId, user_id: userId } },
          create: { group_id: groupId, user_id: userId },
          update: {},
        })
      : db.groupMember.deleteMany({ where: { group_id: groupId, user_id: userId } });

    await db.$transaction([
      write,
      this.audit.statement(accountId, {
        action: add ? 'group_member.add' : 'group_member.remove',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: groupId,
        // `target_ref` names the group; the person is the affected party, counted rather than copied.
        detail: { scope: 'group', affectedCount: 1 },
      }),
    ] as never);

    return { status: 'ok', affectedUserIds: [userId], groupId };
  }

  /**
   * Grant or revoke one catalogue permission on a group.
   *
   * There is no third state. `grant: false` DELETES the row, which returns the group to silence about
   * that key — it never denies it, so a member who holds the key from their role or from another
   * group keeps it (ADR 0039 §3).
   *
   * ⚠️ **NO-ESCALATION (FR-015), and it closes a real hole rather than a theoretical one.** Managing
   * groups is `platform.group.manage`, which `admin` holds. Granting a permission to a group was
   * therefore, in the first draft of this service, a way for an `admin` to obtain
   * `platform.role.manage` — a **super-admin exclusive they deliberately do not have** (011 FR-018):
   * create a group, grant it the key, join the group. Three ordinary calls, each individually
   * permitted, ending in a privilege the role matrix withholds.
   *
   * So a caller may only confer a key they **already hold themselves**, resolved live through the one
   * resolver. That makes the group path strictly no more powerful than the caller already is, which
   * is what "the same escalation rule as granting directly" has to mean here: the direct path is
   * super-admin-only, and a super-admin holds everything, so the two agree wherever they overlap and
   * the group path can never exceed the direct one. `group-grant-parity.spec.ts` pins it.
   *
   * Revoking is NOT gated this way. Taking a grant away reduces access, so it cannot escalate — and
   * requiring the key to remove it would leave a group holding a permission nobody present is able to
   * clean up.
   */
  async setPermission(
    accountId: string,
    actor: Actor,
    actorKeys: readonly string[],
    groupId: string,
    permissionKey: string,
    grant: boolean,
  ): Promise<GroupOutcome> {
    const db = this.prisma.forAccount(accountId);

    const group = await db.group.findFirst({ where: { id: groupId } });
    if (!group) return { status: 'not_found' };
    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    // A key outside the catalogue is refused: the catalogue is closed, and a group must not become
    // the one place a new permission key can be invented (FR-008).
    if (!perm) return { status: 'unknown_permission' };
    if (grant && !actorKeys.includes(permissionKey)) return { status: 'escalation' };

    const members = (await db.groupMember.findMany({ where: { group_id: groupId } })).map(
      (m) => m.user_id,
    );

    const write = grant
      ? db.groupPermission.upsert({
          where: {
            group_id_permission_id: { group_id: groupId, permission_id: perm.id },
          },
          create: { group_id: groupId, permission_id: perm.id },
          update: {},
        })
      : db.groupPermission.deleteMany({ where: { group_id: groupId, permission_id: perm.id } });

    await db.$transaction([
      write,
      this.audit.statement(accountId, {
        action: grant ? 'group_permission.grant' : 'group_permission.revoke',
        actorUserId: actor.userId,
        underPreview: actor.underPreview,
        targetRef: groupId,
        detail: { scope: 'group', permissionKey, grant, affectedCount: members.length },
      }),
    ] as never);

    // Every member's effective set just changed. Missing one of them here is the whole defect this
    // field exists to prevent.
    return { status: 'ok', affectedUserIds: members, groupId };
  }

  private async keysOf(db: ScopedDb, groupId: string): Promise<string[]> {
    const grants = await db.groupPermission.findMany({ where: { group_id: groupId } });
    if (grants.length === 0) return [];
    const perms = await db.permission.findMany({
      where: { id: { in: grants.map((g) => g.permission_id) } },
    });
    return perms.map((p) => p.key).sort();
  }
}

/**
 * Trim, then validate. Trimming BEFORE the uniqueness comparison is the point: two groups differing
 * only by a trailing space are two groups an administrator cannot tell apart, which is worse than
 * refusing the second one.
 *
 * @returns the normalised name, or `null` when it is not a usable name at all.
 */
export function normaliseName(raw: string | undefined): string | null {
  const name = (raw ?? '').trim();
  if (name.length === 0) return null;
  if (name.length > MAX_GROUP_NAME_LENGTH) return null;
  return name;
}
