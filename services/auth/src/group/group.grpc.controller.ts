import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { hasPermission } from '@crm/common';
import { RbacResolverService } from '../rbac/resolver.service';
import { GroupService, type GroupOutcome } from './group.service';

/**
 * Group gRPC surface (feature 024, roadmap 5.3 — ADR 0039). Eight handlers, one entity.
 *
 * ── The permission, and why it is not the role key ──────────────────────────────────────────────
 * `platform.group.manage`, a NEW catalogue key. Reusing `platform.role.manage` was the obvious
 * shortcut and is wrong: that key is a super-admin exclusive (011 FR-018), while reorganising a desk
 * is a routine operational act. One key per scope — feature 017's stated precedent for exports —
 * so a later group capability cannot inherit today's grant.
 *
 * ── The second tier, done properly ──────────────────────────────────────────────────────────────
 * The neighbouring RBAC management handlers re-check with `isSuperAdmin(callerRoles)`, because a role
 * is all the caller context that request carries. This service can do better and therefore does: auth
 * IS the resolver, so it resolves the caller's OWN effective permissions and asks the same question
 * the gateway asked. A call that skips the gateway is refused on the same grounds rather than on a
 * weaker proxy for them — and a permission granted THROUGH A GROUP works here too, because there is
 * only one resolver and it does not care where a key came from.
 *
 * Returns enum NAMES on the wire (enums:String), matching the RBAC controller. No secret and no
 * personal data appears in any reply (Principle IV) — a refusal names a status, never a value.
 */

interface CallerCtx {
  callerAccountId: string;
  callerUserId: string;
  callerRoles: string[];
  /** Feature 015: the caller was previewing another role. Recorded, never trusted as authority. */
  callerUnderPreview?: boolean;
}
interface CreateGroupRequest extends CallerCtx {
  name: string;
}
interface RenameGroupRequest extends CallerCtx {
  groupId: string;
  name: string;
}
interface SetGroupRoutableRequest extends CallerCtx {
  groupId: string;
  /** proto3 omits a false bool, so this may be absent — read as NOT routable. */
  routable?: boolean;
}
interface DeleteGroupRequest extends CallerCtx {
  groupId: string;
}
interface ListGroupsRequest {
  accountId: string;
}
interface GroupMemberRequest extends CallerCtx {
  groupId: string;
  userId: string;
}
interface ListGroupMembersRequest {
  accountId: string;
  groupId: string;
}
interface SetGroupPermissionRequest extends CallerCtx {
  groupId: string;
  permissionKey: string;
  grant: boolean;
}

export const GROUP_MANAGE_KEY = 'platform.group.manage';

const OK = 'GROUP_STATUS_OK';
const FORBIDDEN = 'GROUP_STATUS_FORBIDDEN';
const NOT_FOUND = 'GROUP_STATUS_NOT_FOUND';
const NAME_TAKEN = 'GROUP_STATUS_NAME_TAKEN';
const INVALID_NAME = 'GROUP_STATUS_INVALID_NAME';
const UNKNOWN_PERMISSION = 'GROUP_STATUS_UNKNOWN_PERMISSION';
const ESCALATION = 'GROUP_STATUS_ESCALATION';

const reply = (status: string, affectedUserIds: string[] = [], groupId = '', message = '') => ({
  status,
  message,
  affectedUserIds,
  groupId,
});

@Controller()
export class GroupGrpcController {
  constructor(
    @Inject(GroupService) private readonly groups: GroupService,
    @Inject(RbacResolverService) private readonly resolver: RbacResolverService,
  ) {}

  @GrpcMethod('AuthService', 'CreateGroup')
  async createGroupRpc(req: CreateGroupRequest) {
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.create(req.callerAccountId, this.actor(req), req.name),
    );
  }

  @GrpcMethod('AuthService', 'RenameGroup')
  async renameGroupRpc(req: RenameGroupRequest) {
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.rename(req.callerAccountId, this.actor(req), req.groupId, req.name),
    );
  }

  @GrpcMethod('AuthService', 'SetGroupRoutable')
  async setGroupRoutableRpc(req: SetGroupRoutableRequest) {
    // Same key as every other group mutation: reorganising a desk is routine, and deciding which desks
    // the router feeds is part of reorganising one.
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.setRoutable(
        req.callerAccountId,
        this.actor(req),
        req.groupId,
        // proto3 omits a false bool, so an absent field is legitimately "not routable".
        req.routable === true,
      ),
    );
  }

  @GrpcMethod('AuthService', 'DeleteGroup')
  async deleteGroupRpc(req: DeleteGroupRequest) {
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.remove(req.callerAccountId, this.actor(req), req.groupId),
    );
  }

  @GrpcMethod('AuthService', 'ListGroups')
  async listGroupsRpc(req: ListGroupsRequest) {
    const groups = await this.groups.list(req.accountId);
    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        active: g.active,
        memberCount: g.memberCount,
        permissionKeys: g.permissionKeys,
      })),
    };
  }

  @GrpcMethod('AuthService', 'AddGroupMember')
  async addGroupMemberRpc(req: GroupMemberRequest) {
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.addMember(req.callerAccountId, this.actor(req), req.groupId, req.userId),
    );
  }

  @GrpcMethod('AuthService', 'RemoveGroupMember')
  async removeGroupMemberRpc(req: GroupMemberRequest) {
    if (!(await this.mayManage(req))) return reply(FORBIDDEN);
    return this.map(
      await this.groups.removeMember(req.callerAccountId, this.actor(req), req.groupId, req.userId),
    );
  }

  /**
   * The routing seam. A group that does not exist answers with an EMPTY list, exactly as a group with
   * no members does — deliberately, because this reply is consumed by auto-assignment, which must not
   * be able to tell the two apart and act differently. What it must never do is confuse either of
   * them with a FAILED call, and that distinction is preserved by the client raising rather than
   * returning an empty list when the hop itself fails (chats `auth.client.ts`).
   */
  @GrpcMethod('AuthService', 'ListGroupMembers')
  async listGroupMembersRpc(req: ListGroupMembersRequest) {
    const members = await this.groups.listMembers(req.accountId, req.groupId);
    return { userIds: members ?? [] };
  }

  /**
   * ⚠️ The only handler that needs the caller's KEYS and not just a yes/no. A caller may confer only
   * what they already hold — otherwise `platform.group.manage` becomes a route to
   * `platform.role.manage`, which is a super-admin exclusive its holder deliberately does not have.
   * See the no-escalation note on `GroupService.setPermission`.
   */
  @GrpcMethod('AuthService', 'SetGroupPermission')
  async setGroupPermissionRpc(req: SetGroupPermissionRequest) {
    const caller = await this.callerAuthority(req);
    if (!caller) return reply(FORBIDDEN);
    return this.map(
      await this.groups.setPermission(
        req.callerAccountId,
        this.actor(req),
        caller,
        req.groupId,
        req.permissionKey,
        req.grant === true,
      ),
    );
  }

  private actor(req: CallerCtx) {
    return { userId: req.callerUserId, underPreview: req.callerUnderPreview === true };
  }

  /**
   * Resolve the caller's own effective permissions and ask for the group key.
   *
   * ⚠️ A caller under the read-only "view as" preview may not mutate anything, and the check below is
   * NOT what enforces that — `readOnly` is. Both are asserted, because a preview that could edit
   * groups would be a preview that grants access, which is the exact opposite of what it is for.
   */
  private async mayManage(req: CallerCtx): Promise<boolean> {
    return (await this.callerAuthority(req)) !== null;
  }

  /**
   * The caller's effective keys if they may manage groups at all, otherwise `null`.
   *
   * Returning the KEYS rather than a boolean is what lets the grant handler enforce no-escalation
   * without resolving twice, and it keeps "may they manage?" and "what may they confer?" answers of
   * the same single resolution — two resolutions could disagree with each other under a concurrent
   * revocation, which is the shape of bug this whole feature is careful about.
   */
  private async callerAuthority(req: CallerCtx): Promise<string[] | null> {
    if (!req.callerAccountId || !req.callerUserId) return null;
    const resolved = await this.resolver.resolve(req.callerAccountId, req.callerUserId);
    if (resolved.readOnly) return null;
    if (!hasPermission(resolved.permissionKeys, GROUP_MANAGE_KEY)) return null;
    return resolved.permissionKeys;
  }

  private map(outcome: GroupOutcome) {
    switch (outcome.status) {
      case 'ok':
        return reply(OK, outcome.affectedUserIds, outcome.groupId);
      case 'name_taken':
        return reply(NAME_TAKEN);
      case 'invalid_name':
        return reply(INVALID_NAME);
      case 'unknown_permission':
        return reply(UNKNOWN_PERMISSION);
      case 'escalation':
        return reply(ESCALATION);
      default:
        return reply(NOT_FOUND);
    }
  }
}
