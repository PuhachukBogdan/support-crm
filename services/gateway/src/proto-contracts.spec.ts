import { TokenClaims } from '@crm/proto';
import { Player } from '@crm/proto';
import { Brand } from '@crm/proto';

/**
 * US1 (feature 006) acceptance: the three new inter-service contracts compile through
 * buf+ts-proto and their message types are importable + shaped as designed. Fails before
 * codegen (stubs absent / barrel not re-exporting); passes after `npm run proto:gen`.
 *
 * ts-proto is configured with `snakeToCamel=true` (buf.gen.yaml) → wire field `account_id`
 * surfaces as `accountId` in TS. We assert the camelCase shape the downstream services consume.
 */
describe('feature 006 inter-service contracts', () => {
  it('auth.proto — TokenClaims carries the routing/authz claims (camelCase)', () => {
    const keys = Object.keys(TokenClaims.create());
    expect(keys).toEqual(
      expect.arrayContaining(['valid', 'userId', 'accountId', 'roles', 'expiresAt']),
    );
  });

  it('users.proto — Player is keyed by playerId, unifies brands, carries no GR8 field', () => {
    const keys = Object.keys(Player.create());
    expect(keys).toEqual(
      expect.arrayContaining([
        'playerId',
        'accountId',
        'brandIds',
        'vip',
        'segment',
        'amNotes',
        'customAttributesJson',
      ]),
    );
    // The opaque GR8 seam lives on the Player DB row, NOT on the read contract (deferred to 7.4).
    expect(keys.some((k) => /gr8/i.test(k))).toBe(false);
  });

  it('brands.proto — Brand exposes identity for cross-service resolution', () => {
    const keys = Object.keys(Brand.create());
    expect(keys).toEqual(expect.arrayContaining(['brandId', 'accountId', 'name', 'active']));
  });
});
