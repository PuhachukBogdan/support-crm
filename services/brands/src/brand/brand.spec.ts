import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { BrandReadController } from './brand.grpc.controller';
import type { PrismaService } from '../prisma.service';

/**
 * The brand registry (feature 020, roadmap 5.2) — the half of 5.2 that is NOT access control.
 *
 * These tests hold two things: that a brand answers with an identity an agent can render, and that it
 * remains account-scoped. There is deliberately **no test that a brand refuses anybody**, because
 * refusing on a brand is not something this product does (ADR 0038 §1).
 */

const ROW = {
  id: 'brand-a',
  account_id: 'acc-1',
  name: 'Brand A',
  slug: 'brand-a',
  active: true,
  icon: 'spade',
  accent: '#2f6f4f',
  settings: { secret: 'unspecified blob nobody has designed' },
};

function harness(rows = [ROW]) {
  const findFirst = jest.fn(async (args: { where: { id: string } }) =>
    rows.find((r) => r.id === args.where.id) ?? null,
  );
  const findMany = jest.fn(async (args: { where?: { active: boolean } }) =>
    args?.where?.active ? rows.filter((r) => r.active) : rows,
  );
  const forAccount = jest.fn(() => ({ brand: { findFirst, findMany } }));
  return {
    ctl: new BrandReadController({ forAccount } as unknown as PrismaService),
    forAccount,
    findFirst,
    findMany,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  if (accountId) m.set('x-actor-account-id', accountId);
  return m;
}

describe('GetBrand — a record’s origin, rendered', () => {
  it('returns the identity an agent recognises', async () => {
    const h = harness();
    const wire = (await h.ctl.getBrand({ brandId: 'brand-a' }, md())) as Record<string, unknown>;
    expect(wire).toEqual({
      brandId: 'brand-a',
      accountId: 'acc-1',
      name: 'Brand A',
      slug: 'brand-a',
      active: true,
      icon: 'spade',
      accent: '#2f6f4f',
    });
  });

  it('*** an EXPLICIT field list — `settings` does not ride along ***', async () => {
    // Same rule feature 018 wrote for the player message: a spread forwards whatever the table gains
    // next, and `settings` is an unspecified JSON blob — exactly the field that would start shipping.
    const h = harness();
    const wire = (await h.ctl.getBrand({ brandId: 'brand-a' }, md())) as Record<string, unknown>;
    expect(wire).not.toHaveProperty('settings');
    expect(JSON.stringify(wire)).not.toContain('unspecified blob');
  });

  it('reads through the account-scoped client (Principle I)', async () => {
    const h = harness();
    await h.ctl.getBrand({ brandId: 'brand-a' }, md('acc-1'));
    expect(h.forAccount).toHaveBeenCalledWith('acc-1');
  });

  it('an unknown brand is NOT_FOUND — same answer another account’s brand gets', async () => {
    const h = harness();
    await expect(h.ctl.getBrand({ brandId: 'nope' }, md())).rejects.toBeInstanceOf(RpcException);
  });

  it('a missing brandId is refused as a malformed request, before any read', async () => {
    const h = harness();
    await expect(h.ctl.getBrand({}, md())).rejects.toMatchObject({
      error: { code: GrpcStatus.INVALID_ARGUMENT },
    });
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('no account context fails closed, before any read', async () => {
    const h = harness();
    await expect(h.ctl.getBrand({ brandId: 'brand-a' }, md(''))).rejects.toMatchObject({
      error: { code: GrpcStatus.PERMISSION_DENIED },
    });
    expect(h.forAccount).not.toHaveBeenCalled();
  });
});

describe('ListBrands — all of them, because a UI needs all of them', () => {
  const INACTIVE = { ...ROW, id: 'brand-b', name: 'Brand B', slug: 'brand-b', active: false };

  it('returns every brand of the account by default, inactive included', async () => {
    // Administration needs the inactive ones; a card rendering an old ticket does too.
    const h = harness([ROW, INACTIVE]);
    const res = await h.ctl.listBrands({}, md());
    expect(res.brands.map((b) => b.brandId)).toEqual(['brand-a', 'brand-b']);
  });

  it('activeOnly narrows it', async () => {
    const h = harness([ROW, INACTIVE]);
    const res = await h.ctl.listBrands({ activeOnly: true }, md());
    expect(res.brands.map((b) => b.brandId)).toEqual(['brand-a']);
  });

  it('every row goes through the same projection', async () => {
    const h = harness([ROW, INACTIVE]);
    const res = await h.ctl.listBrands({}, md());
    for (const b of res.brands) expect(b).not.toHaveProperty('settings');
  });

  it('is account-scoped, and fails closed without a context', async () => {
    const h = harness();
    await h.ctl.listBrands({}, md('acc-1'));
    expect(h.forAccount).toHaveBeenCalledWith('acc-1');
    await expect(h.ctl.listBrands({}, md(''))).rejects.toBeInstanceOf(RpcException);
  });
});

describe('*** the service refuses nobody on the basis of a brand ***', () => {
  it('serves no access check, and the contract entry for one is deprecated', () => {
    // ADR 0038 §1. `CheckBrandAccess` survives in the contract only because removing an rpc trips
    // `buf breaking`; nothing serves it, and this asserts that nothing does.
    const handlers = Object.getOwnPropertyNames(BrandReadController.prototype).filter(
      (n) => n !== 'constructor',
    );
    expect(handlers.sort()).toEqual(['accountOf', 'getBrand', 'listBrands']);
    expect(handlers).not.toContain('checkBrandAccess');
  });
});
