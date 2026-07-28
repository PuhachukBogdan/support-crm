import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';

/**
 * Caller context for the player and operator reads (feature 018, roadmap 5.1 / research R2).
 *
 * Deliberately the same shape and the same reading discipline as `../uploads/actor.ts` rather than a
 * second convention — a service with two ways to read its caller context has two places for a
 * fail-closed check to be forgotten.
 *
 * ── ⚠️ `x-actor-role` is NOT the masking input ───────────────────────────────────────────────────
 * That header carries who the caller **is** (`claims.roles[0]`) and, until this feature, was read by
 * nothing anywhere in the product. Masking needs the role the caller is **acting as**: under a view-as
 * preview the auth resolver returns the PREVIEWED role, and masking a previewed session as the owner's
 * real role is the exact opposite of what view-as exists for (feature 011 US5). So the masking input is
 * **`x-actor-effective-role`**, and this file names the distinction because the two headers differ only
 * in the one case where it matters.
 *
 * ── Fail-closed on an absent role ───────────────────────────────────────────────────────────────
 * An empty effective role is returned as an empty string and **must** be handed to the tier policy
 * unchanged. The policy treats an unknown role as open-only, so absence degrades to the most restricted
 * tier by itself — which is why this file does not "helpfully" substitute a default. A default here
 * would be a privilege decision made in a metadata reader.
 */

export interface PlayerActor {
  accountId: string;
  userId: string;
  permissions: string[];
  /** The role the caller is ACTING AS — the previewed one under view-as. The masking input. */
  effectiveRole: string;
  /** View-as active. The audit entry records the REAL caller plus this marker, never the previewed role. */
  underPreview: boolean;
}

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const forbidden = () =>
  new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });

/**
 * Read + validate the caller. Fail-closed: no account context, no tenant data (Principle I).
 *
 * Refusing on a missing account **before** anything else is what makes a call that skips the gateway
 * pointless rather than merely discouraged — it carries no context, so there is nothing to scope a read
 * to and nothing to attribute an audit entry to.
 */
export function readPlayerActor(md: Metadata | undefined): PlayerActor {
  const accountId = readStr(md, 'x-actor-account-id');
  if (!accountId) throw forbidden();

  const permsRaw = readStr(md, 'x-actor-permissions');
  return {
    accountId,
    userId: readStr(md, 'x-actor-user-id'),
    permissions: permsRaw ? permsRaw.split(',').filter(Boolean) : [],
    // Not defaulted. See the header: an unknown role is open-only by policy, and choosing a fallback
    // here would move a privilege decision into a metadata reader.
    effectiveRole: readStr(md, 'x-actor-effective-role'),
    underPreview: readStr(md, 'x-is-preview') === 'true',
  };
}
