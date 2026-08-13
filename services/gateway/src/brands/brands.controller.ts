import { Controller, Get, Inject, OnModuleInit, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import { BRANDS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { callUploads } from '../uploads/rpc';

interface BrandWire {
  brandId?: string;
  accountId?: string;
  name?: string;
  slug?: string;
  active?: boolean;
  icon?: string;
  accent?: string;
}
interface BrandListWire {
  brands?: BrandWire[];
}
interface BrandsReadGrpc {
  listBrands(d: { activeOnly: boolean }, md?: unknown): Observable<BrandListWire>;
}

type BrandsReq = Request & { claims?: RequestClaims };

/**
 * ⭐ W11 (roadmap 9.17) — the brands READ edge, and the reason it exists at all.
 *
 * `brandId` is a REQUIRED parameter on every player read (the same platform id under two brands is
 * two human beings — the 2026-07-29 Person repair), and until now the browser had no way to learn
 * which brands an account has: the gateway dialled `brands` only for readiness. The customer
 * directory therefore could not ask its first question. This is that list, and nothing more.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────────────────────────
 * ⚠️ **A brand is a FILTER, not a wall** (ADR 0038 §1). Nobody is refused a conversation or a
 * customer because of its brand, and reading this list grants nothing: it answers *which brands
 * exist in your account*, the same fact every conversation row already carries. So it is gated by
 * `crm.inbox.view` — the key everyone who works in the product holds — rather than by a new key
 * that would imply brands are an access dimension. The narrowing that DOES matter (who may bulk-read
 * customers) lives where it always did: the tier guard inside `users`.
 *
 * ⓘ Unpaged on purpose: an account has single digits of brands, and the owning service says so at
 * its own handler. A page token here would be ceremony over a list that fits on a line.
 */
@Controller('brands')
export class BrandsController implements OnModuleInit {
  private read!: BrandsReadGrpc;

  constructor(@Inject(BRANDS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<BrandsReadGrpc>('BrandsReadService');
  }

  @Get()
  @RequiresPermission('crm.inbox.view')
  async list(@Req() req: BrandsReq) {
    const accountId = req.claims?.accountId ?? '';
    const res = await callUploads(
      this.read.listBrands(
        // Active only: a retired brand still labels last year's conversations (so the id resolves
        // wherever it appears), but it is not something to START a new read against.
        { activeOnly: true },
        metadataFor(accountId),
      ),
    );

    // An explicit projection, never a spread: the wire message carries `icon`/`accent` for the
    // theming layer, and a chooser has no business shipping them to every caller.
    const brands = (res as BrandListWire)?.brands ?? [];
    return {
      brands: brands
        .filter((b) => !!b?.brandId)
        .map((b) => ({ brandId: b.brandId!, name: b.name ?? '', slug: b.slug ?? '' })),
    };
  }
}

/**
 * The account travels as metadata, exactly as it does for every other service call — never as a
 * body or query field. `brands` reads nothing else from the actor: its own handler requires the
 * account id and nothing more.
 */
function metadataFor(accountId: string) {
  const md = new Metadata();
  md.set('x-actor-account-id', accountId);
  return md;
}
