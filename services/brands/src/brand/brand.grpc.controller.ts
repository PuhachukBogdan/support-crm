import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { PrismaService } from '../prisma.service';

/**
 * `BrandsReadService` — the brand registry (feature 020, roadmap 5.2).
 *
 * ── What a brand IS here, stated once ───────────────────────────────────────────────────────────
 * **Identification, never permission** (ADR 0038 §1). The operation has one support department: the
 * same agents handle brand A, brand B and every later brand at the same time, in one queue. So what a
 * brand needs from this service is a name and a badge — enough for an agent to see at a glance where
 * a ticket came from. It never decides who may see it.
 *
 * `CheckBrandAccess` is declared in the contract and **deliberately not served**. It asks a question
 * this product does not ask. It survives only because removing an rpc trips the compatibility gate;
 * `hosting.spec.ts` asserts the served set, so wiring a handler for it would be a failing test rather
 * than a quiet revival.
 *
 * ── This is not the install's theming ───────────────────────────────────────────────────────────
 * `icon` and `accent` mark a RECORD's origin inside one interface. The application's own identity —
 * logo, palette, name — is the token layer (ADR 0028), and with one department watching every brand
 * in one inbox a per-ticket theme switch would be incoherent. ADR 0038 §4 separates the two.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Controller()
export class BrandReadController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The caller's account, from the metadata every service already trusts. Fail-closed. */
  private accountOf(metadata: Metadata): string {
    const raw = metadata?.get?.('x-actor-account-id')?.[0];
    const accountId = typeof raw === 'string' ? raw : raw?.toString('utf8');
    if (!accountId) {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    return accountId;
  }

  @GrpcMethod('BrandsReadService', 'GetBrand')
  async getBrand(req: { brandId?: string }, metadata: Metadata) {
    const accountId = this.accountOf(metadata);
    const brandId = String(req?.brandId ?? '');
    if (!brandId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'brandId is required' });
    }

    // Scoped by account, so "another account's brand" and "no such brand" are the same query result
    // rather than two branches a later edit could separate (Principle I).
    const row = await this.prisma.forAccount(accountId).brand.findFirst({ where: { id: brandId } });
    if (!row) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toWire(row);
  }

  /**
   * Every brand of the account.
   *
   * Not paged, and that is a decision rather than an omission: a company's brands are counted in
   * single digits, and the caller is a UI that needs all of them at once to render a badge for any
   * record it holds. Paging here would be machinery serving no case (Principle VII cuts both ways).
   */
  @GrpcMethod('BrandsReadService', 'ListBrands')
  async listBrands(req: { activeOnly?: boolean }, metadata: Metadata) {
    const accountId = this.accountOf(metadata);
    const rows = await this.prisma.forAccount(accountId).brand.findMany({
      ...(req?.activeOnly ? { where: { active: true } } : {}),
      orderBy: [{ name: 'asc' }],
    });
    return { brands: rows.map(toWire) };
  }
}

/**
 * Row → wire, as an EXPLICIT field list rather than a spread.
 *
 * Same rule feature 018 wrote for the player message and for the same reason: a passthrough forwards
 * whatever the table gains next. `settings` is a JSON blob whose contents nobody has specified, and it
 * is exactly the field a spread would start publishing.
 */
function toWire(row: {
  id: string;
  account_id: string;
  name: string;
  slug: string;
  active: boolean;
  icon: string;
  accent: string;
}) {
  return {
    brandId: row.id,
    accountId: row.account_id,
    name: row.name,
    slug: row.slug,
    active: row.active,
    icon: row.icon,
    accent: row.accent,
  };
}
