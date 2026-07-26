import { TokenClaims } from '@crm/proto';
import {
  LoginStatus,
  LoginChallenge,
  VerifyLoginCodeRequest,
  LogoutResult,
  RefreshRequest,
} from '@crm/proto';
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

  it('auth.proto — 2-step login surface (feature 009): challenge/verify/logout messages', () => {
    // Step-1 result: a challenge, never a token; status is the LoginStatus enum.
    const challenge = Object.keys(LoginChallenge.create());
    expect(challenge).toEqual(
      expect.arrayContaining(['status', 'challengeId', 'codeExpiresAt']),
    );
    // Step-2 request carries the challenge handle, the code, and the remember-me class.
    const verify = Object.keys(VerifyLoginCodeRequest.create());
    expect(verify).toEqual(expect.arrayContaining(['challengeId', 'code', 'rememberMe']));
    // Refresh gained the remember_me echo (additive) so rotation preserves the session class.
    expect(Object.keys(RefreshRequest.create())).toEqual(
      expect.arrayContaining(['refreshToken', 'rememberMe']),
    );
    expect(Object.keys(LogoutResult.create())).toEqual(expect.arrayContaining(['revoked']));
    // LoginStatus models CODE_SENT (the only success) distinctly from the generic failure.
    expect(LoginStatus.CODE_SENT).not.toBe(LoginStatus.INVALID_CREDENTIALS);
    expect(LoginStatus.LOCKED).not.toBe(LoginStatus.CODE_SENT);
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
