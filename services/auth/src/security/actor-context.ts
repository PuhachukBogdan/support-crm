import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';

/**
 * Caller context the gateway sets in gRPC metadata — the auth-side twin of
 * `services/chats/src/security/actor-context.ts`.
 *
 * ⚠️ **Identity is never read from a request body.** The W31 key messages (`IssueApiKeyRequest`,
 * `ApiKeyIdRequest`, `ListApiKeysRequest`) deliberately carry no caller fields at all, so there is
 * nothing for a crafted request to claim: who is asking comes from the gateway's VALIDATED claims,
 * forwarded as metadata, or the call is refused (ADR 0043 §5 / SEC-PV1).
 *
 * Duplicated rather than shared with chats for the reason `audit.guard.ts` already records:
 * `libs/common` carries no NestJS dependency, and adding one to host thirty lines would be the
 * larger change.
 */
export interface ActorContext {
  accountId: string;
  userId: string;
  /**
   * Feature 015: the caller was previewing another role (owner view-as). The audit entry records the
   * REAL user plus this marker — never the previewed role, which nobody performed anything as.
   */
  underPreview?: boolean;
}

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/** Read + validate the actor context. Fail-closed: no account context → PERMISSION_DENIED. */
export function readActorContext(md: Metadata | undefined): ActorContext {
  const accountId = readStr(md, 'x-actor-account-id');
  const userId = readStr(md, 'x-actor-user-id');
  if (!accountId) {
    throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
  }
  const underPreview = readStr(md, 'x-is-preview') === 'true';
  return { accountId, userId, ...(underPreview ? { underPreview } : {}) };
}

/**
 * The caller's effective permissions, as the gateway forwarded them (comma-joined).
 *
 * An EMPTY result is a real answer ("this caller holds nothing") and fails closed at every call
 * site — it is also the shape of feature 016's live defect, where a route carrying no permission
 * metadata made the gateway forward an empty value and the owning service correctly refused.
 */
export function readActorPermissions(md: Metadata | undefined): string[] {
  return readStr(md, 'x-actor-permissions').split(',').filter(Boolean);
}
