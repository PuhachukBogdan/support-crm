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
  return { accountId, userId, ...(brands ? { brands } : {}) };
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
