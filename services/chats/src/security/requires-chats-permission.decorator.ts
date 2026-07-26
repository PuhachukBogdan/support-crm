import { SetMetadata } from '@nestjs/common';

/** Metadata key: the permission a chats gRPC handler requires (feature 012, mirrors 011). */
export const REQUIRED_CHATS_PERMISSION_KEY = 'rbac:chats_required_permission';

/**
 * Declare the permission a chats read/write handler requires. The {@link ChatsAccessGuard} enforces
 * it against the caller-permission context carried in gRPC metadata (`x-actor-permissions`) —
 * independently of the gateway, so a request that skips the gateway is refused at the service tier
 * (Principle II / SC-004).
 */
export const RequiresChatsPermission = (permission: string) =>
  SetMetadata(REQUIRED_CHATS_PERMISSION_KEY, permission);
