import { scopeArgs } from '@crm/common';

/**
 * US3 / SC-005 (feature 007, ADR 0032 §0.2): the player-union brand exception coexists with account
 * isolation. A player spanning two brands reads back unified across both brands, WHILE the account
 * predicate still applies to the player read (the carve-out is brand-level, never account-level).
 * Docker-independent (Track A); live read-back on beton-test (Track B).
 */
const SCOPED = ['Player'];

type Args = { where?: Record<string, unknown>; include?: Record<string, unknown> };

describe('player-union exception + account isolation together', () => {
  it('an account-scoped player read preserves the brand-union include (not brand-walled)', () => {
    const args = scopeArgs(
      'Player',
      'findUnique',
      { where: { player_id: 'p-1' }, include: { brands: true } },
      'acc-A',
      SCOPED,
    ) as Args;

    // brand-union preserved — the read is NOT filtered by brand.
    expect(args.include).toEqual({ brands: true });
    // account isolation still applies to the player itself.
    expect(args.where?.account_id).toBe('acc-A');
    expect(args.where?.player_id).toBe('p-1');
  });

  it('the union never crosses an account: a player read in account A cannot resolve an account-B player', () => {
    const args = scopeArgs(
      'Player',
      'findUnique',
      { where: { player_id: 'p-shared', account_id: 'acc-B' }, include: { brands: true } },
      'acc-A',
      SCOPED,
    ) as Args;

    // A caller cannot pin the read to another account — account_id is forced to the caller's.
    expect(args.where?.account_id).toBe('acc-A');
  });

  it('the brand-union edge (PlayerBrand) is NOT account-scoped (it inherits the parent scope)', () => {
    // PlayerBrand is a join table (no account_id) — the extension must leave it untouched so the
    // union across brands is returned intact; its isolation comes from the account-scoped Player.
    const args = { where: { player_id: 'p-1' } };
    expect(scopeArgs('PlayerBrand', 'findMany', args, 'acc-A', SCOPED)).toEqual(args);
  });
});
