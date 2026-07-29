import {
  playerIdentity,
  identityWhere,
  sameIdentity,
  identityLabel,
  IncompletePlayerIdentityError,
} from './player.identity';

/**
 * T002 (feature 020) — the identity definition.
 *
 * The assertions that matter are the refusals. A caller holding only a platform id must be unable
 * to construct an identity at all: that is what turns "we forgot the brand here" from a wrong answer
 * into a loud one, and it is the property the previous key lacked.
 */

const A = { accountId: 'acc-1', brandId: 'brand-a', playerId: '12345' };

describe('an identity needs all three parts', () => {
  it('builds from a complete triple', () => {
    expect(playerIdentity(A)).toEqual(A);
  });

  it.each([
    ['accountId', { brandId: 'brand-a', playerId: '12345' }],
    ['brandId', { accountId: 'acc-1', playerId: '12345' }],
    ['playerId', { accountId: 'acc-1', brandId: 'brand-a' }],
  ])('refuses a triple missing %s', (missing, parts) => {
    expect(() => playerIdentity(parts)).toThrow(IncompletePlayerIdentityError);
    expect(() => playerIdentity(parts)).toThrow(missing);
  });

  it('refuses an EMPTY brand as firmly as an absent one', () => {
    // The realistic mistake: a caller passes `brandId: ''` from an unfilled field and gets a
    // silently unscoped lookup. Empty is not a brand.
    expect(() => playerIdentity({ ...A, brandId: '' })).toThrow(IncompletePlayerIdentityError);
    expect(() => playerIdentity({ ...A, brandId: '   ' })).toThrow(IncompletePlayerIdentityError);
  });

  it('the refusal names the missing PART and never the values', () => {
    const err = (() => {
      try {
        playerIdentity({ accountId: 'acc-1', playerId: 'seed-player-001' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a refusal');
    })();

    expect(err.message).toContain('brandId');
    expect(err.message).not.toContain('seed-player-001');
    expect(err.message).not.toContain('acc-1');
  });
});

describe('*** the same platform id under two brands is two different players ***', () => {
  const brandA = playerIdentity({ accountId: 'acc-1', brandId: 'brand-a', playerId: '12345' });
  const brandB = playerIdentity({ accountId: 'acc-1', brandId: 'brand-b', playerId: '12345' });

  it('they are not the same identity', () => {
    // The whole feature in one assertion. Before this change these two were one row.
    expect(sameIdentity(brandA, brandB)).toBe(false);
  });

  it('they select different rows', () => {
    expect(identityWhere(brandA)).not.toEqual(identityWhere(brandB));
  });

  it('and the same id in two ACCOUNTS is two players as well', () => {
    // The dormant half of the same mistake: the old key would have blocked two licensees from
    // both holding player 12345.
    const other = playerIdentity({ accountId: 'acc-2', brandId: 'brand-a', playerId: '12345' });
    expect(sameIdentity(brandA, other)).toBe(false);
  });

  it('an identity equals itself and its twin', () => {
    expect(sameIdentity(brandA, { ...brandA })).toBe(true);
  });
});

describe('the Prisma selector', () => {
  it('names all three columns, account first (matching the primary key order)', () => {
    const where = identityWhere(playerIdentity(A));
    expect(Object.keys(where.account_id_brand_id_player_id)).toEqual([
      'account_id',
      'brand_id',
      'player_id',
    ]);
  });

  it('carries the values unchanged', () => {
    expect(identityWhere(playerIdentity(A)).account_id_brand_id_player_id).toEqual({
      account_id: 'acc-1',
      brand_id: 'brand-a',
      player_id: '12345',
    });
  });
});

describe('the label is for humans, not for storage', () => {
  it('renders all three parts', () => {
    expect(identityLabel(playerIdentity(A))).toBe('acc-1/brand-a/12345');
  });

  it('there is no parser back from it', () => {
    // Deliberate: parsing a joined string into three parts is how a delimiter inside a brand id
    // becomes a security bug. Storage uses the three columns; this is for logs and test output.
    const mod = jest.requireActual<Record<string, unknown>>('./player.identity');
    const parsers = Object.keys(mod).filter((k) => /^parse|fromLabel|fromString/.test(k));
    expect(parsers).toEqual([]);
  });
});
