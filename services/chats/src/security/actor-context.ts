import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';

/**
 * Caller context the gateway sets in gRPC metadata (feature 012, research R1/R3). Identity is the
 * gateway's VALIDATED claims — never trusted from a request body. `brands` is undefined when the
 * caller's brand scope is not populated (Brands service, Phase 5): the chats reads then apply NO
 * brand filter, mirroring the gateway guard's own deferral.
 */
export interface ActorContext {
  accountId: string;
  userId: string;
  /** Permitted brand ids; undefined = brand scope not populated yet → no brand restriction. */
  brands?: string[];
  /**
   * Feature 015: the caller is previewing another role (owner view-as, `x-is-preview`). An audit entry
   * records the REAL user plus this marker — never the previewed role, which nobody performed anything as.
   * Preview is read-only, so this should never be true on a mutation; recording it anyway means a regression
   * in that rule shows up in the trail instead of being invisible.
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
  const brandsRaw = readStr(md, 'x-actor-brands');
  const brands = brandsRaw ? brandsRaw.split(',').filter(Boolean) : undefined;
  const underPreview = readStr(md, 'x-is-preview') === 'true';
  return { accountId, userId, ...(brands ? { brands } : {}), ...(underPreview ? { underPreview } : {}) };
}

/**
 * The caller's effective permissions, as the gateway forwarded them (feature 017).
 *
 * Needed by a handler whose required key is not a literal: an export scope names its own permission, so
 * the declarative `@RequiresChatsPermission('...')` cannot express it — the same problem the gateway
 * solved with `RequiresScopePermission`. The service tier therefore checks the resolved key itself, and
 * this is how it reads the set.
 *
 * An EMPTY result is a real answer ("this caller holds nothing") and must fail closed at the call site.
 * It is also the shape of feature 016's live defect: a route that carries no permission metadata makes
 * the gateway forward an empty value, and the owning service then correctly refuses everything.
 */
export function readActorPermissions(md: Metadata | undefined): string[] {
  return readStr(md, 'x-actor-permissions').split(',').filter(Boolean);
}

/**
 * Resolve the brand-id filter for a collection read (R3):
 * - brands known + explicit request brandId → that brand iff permitted, else [] (empty result).
 * - brands known, no request brandId → all permitted brands.
 * - brands unknown (Phase-5 defer) → request brandId if given, else undefined (no restriction).
 */
export function resolveBrandIn(ctx: ActorContext, requestBrandId?: string): string[] | undefined {
  const reqBrand = requestBrandId || undefined;
  if (ctx.brands) {
    if (reqBrand) return ctx.brands.includes(reqBrand) ? [reqBrand] : [];
    return ctx.brands;
  }
  return reqBrand ? [reqBrand] : undefined;
}

/** True when the caller may access a specific brand (singleton resource-check, R3). */
export function mayAccessBrand(ctx: ActorContext, brandId: string): boolean {
  return !ctx.brands || ctx.brands.includes(brandId);
}
