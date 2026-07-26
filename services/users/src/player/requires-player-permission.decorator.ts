import { SetMetadata } from '@nestjs/common';

/** Metadata key: the permission a player-read gRPC handler requires (feature 011, T019). */
export const REQUIRED_PLAYER_PERMISSION_KEY = 'rbac:player_required_permission';

/**
 * Declare the permission a Users player-read handler requires. The {@link PlayerAccessGuard}
 * enforces it against the caller-permission context carried in gRPC metadata — independently of
 * the gateway, so a request that skips the gateway is refused at the service tier (SC-001).
 */
export const RequiresPlayerPermission = (permission: string) =>
  SetMetadata(REQUIRED_PLAYER_PERMISSION_KEY, permission);
