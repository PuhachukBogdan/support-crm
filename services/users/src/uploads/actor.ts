import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { hasPermission, purposeOf } from '@crm/common';

/**
 * Caller context + the service-tier permission check for the uploads surface (feature 016).
 *
 * ── Why this is not a `@UseGuards` decorator like the audit surface ──────────────────────────────
 * The audit guard can be declarative because its key is a constant. Here the required permission
 * depends on the PURPOSE — which arrives in the request for `CreateUpload` and comes from the stored
 * row for a read or a claim. A guard would have to re-do the lookup the handler is about to do
 * anyway, and a guard that silently passes when it cannot resolve the key is worse than no guard.
 * So the check is an explicit call the handler makes, and every handler makes it.
 *
 * This is the SECOND tier (Principle II). The gateway checks the same key from the same catalogue;
 * a call that skips the gateway carries no permission context and is refused here.
 */

export interface UploadActor {
  accountId: string;
  userId: string;
  permissions: string[];
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

/** Read + validate the actor. Fail-closed: no account context, no tenant data (Principle I). */
export function readUploadActor(md: Metadata | undefined): UploadActor {
  const accountId = readStr(md, 'x-actor-account-id');
  if (!accountId) throw forbidden();
  const permsRaw = readStr(md, 'x-actor-permissions');
  return {
    accountId,
    userId: readStr(md, 'x-actor-user-id'),
    permissions: permsRaw ? permsRaw.split(',').filter(Boolean) : [],
    underPreview: readStr(md, 'x-is-preview') === 'true',
  };
}

/**
 * True iff `actor` may act on `purposeName`.
 *
 * A purpose whose `permission` is `null` means "authenticated is sufficient" — and authenticated is
 * already established, because `readUploadActor` refuses without an account. It never means "skip
 * the check": an UNKNOWN purpose returns false, so a typo cannot land in the permissive branch.
 */
export function mayActOnPurpose(actor: UploadActor, purposeName: string): boolean {
  const purpose = purposeOf(purposeName);
  if (!purpose) return false;
  if (purpose.permission === null) return true;
  return hasPermission(actor.permissions, purpose.permission);
}

/** Refuse unless `actor` may act on `purposeName`. Generic message — reveals nothing (no enumeration). */
export function assertPurposePermission(actor: UploadActor, purposeName: string): void {
  if (!mayActOnPurpose(actor, purposeName)) throw forbidden();
}

/**
 * Refuse a write while an owner view-as preview is active (feature 011, US5).
 *
 * The gateway already blocks mutating HTTP methods under preview, so reaching this is a regression
 * rather than a normal path — which is exactly why it is checked again here. A preview that could
 * write would let the owner take actions attributed to a role nobody performed them as.
 */
export function assertNotPreview(actor: UploadActor): void {
  if (actor.underPreview) throw forbidden();
}
