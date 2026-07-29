import { toPlayerResponse, toPlayerPageResponse } from './wire';

/**
 * Feature 019 — the masking guarantee's last mile at the REST edge (011's FR-014).
 *
 * Until 2026-07-29 this route returned the decoded gRPC message unchanged, so every key arrived for
 * every role with withheld fields blanked. The requirement says ABSENT. Found by 019's live run;
 * recorded in `specs/019-gateway-transport/fixtures/player-get-{admin,support}.json`.
 *
 * Two properties are asserted together because either alone is satisfiable by a wrong implementation:
 * a withheld field must be gone, AND the response must not reveal which fields were withheld.
 */

const CLEARED = {
  playerId: 'ply-1',
  accountId: 'acc-1',
  brandId: 'b1',
  brandIds: ['b1'],
  vip: true,
  segment: 'high-roller',
  amNotes: 'prefers calls after 18:00',
  customAttributesJson: '{"source":"affiliate-7"}',
  preferencesJson: '{"channel":"telegram"}',
  portfolioJson: '{"tier":"gold"}',
};

/** What the decoder hands the edge for a linear role: same keys, proto3 defaults in place. */
const MASKED = {
  playerId: 'ply-1',
  accountId: 'acc-1',
  brandId: 'b1',
  brandIds: ['b1'],
  vip: false,
  segment: '',
  amNotes: '',
  customAttributesJson: '',
  preferencesJson: '',
  portfolioJson: '',
};

describe('*** a withheld field is ABSENT from the response, not blanked (FR-014) ***', () => {
  it('drops every default-valued field', () => {
    const out = toPlayerResponse(MASKED);
    for (const k of [
      'vip',
      'segment',
      'amNotes',
      'customAttributesJson',
      'preferencesJson',
      'portfolioJson',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
    expect(out).toEqual({ playerId: 'ply-1', accountId: 'acc-1', brandId: 'b1', brandIds: ['b1'] });
  });

  it('keeps every populated field for a cleared caller', () => {
    expect(toPlayerResponse(CLEARED)).toEqual(CLEARED);
  });

  it('a false boolean is dropped as the default it is, not preserved as data', () => {
    // Canonical protobuf→JSON. `vip: false` and "vip withheld" are the same bytes on the wire, so the
    // edge cannot distinguish them and must not pretend to.
    expect(toPlayerResponse({ ...CLEARED, vip: false })).not.toHaveProperty('vip');
  });
});

describe('*** the response does not reveal WHICH fields were withheld ***', () => {
  it('a genuinely empty field is absent for the same reason a withheld one is', () => {
    // This is why the projection keys off the VALUE and not off the caller's clearance. Marking the
    // proto fields `optional` would satisfy FR-014 and break THIS: a genuinely empty field would
    // arrive as "" while a withheld one vanished, handing the caller a list of what it was denied.
    const clearedButEmpty = toPlayerResponse({ ...CLEARED, amNotes: '' });
    const withheld = toPlayerResponse(MASKED);
    expect(Object.prototype.hasOwnProperty.call(clearedButEmpty, 'amNotes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(withheld, 'amNotes')).toBe(false);
  });

  it('carries no tier, no field list, no count of what was hidden', () => {
    const out = toPlayerResponse(MASKED);
    for (const k of ['tier', 'maskedFields', 'withheld', 'clearance', 'hiddenCount']) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
  });
});

describe('*** an EXPLICIT field list, never a spread ***', () => {
  it('a field the contract does not declare cannot ride along', () => {
    // Rule 1 of the row→wire mapping, restated at this edge: the one field deliberately absent from
    // the contract is a customer PII snapshot, and a passthrough would forward whatever appears next.
    const out = toPlayerResponse({ ...CLEARED, gr8Snapshot: { phone: '+34600111222' } });
    expect(JSON.stringify(out)).not.toContain('34600111222');
    expect(Object.prototype.hasOwnProperty.call(out, 'gr8Snapshot')).toBe(false);
  });
});

describe('the paged form uses the same projection', () => {
  it('every row is projected, and the token is passed through untouched', () => {
    const page = toPlayerPageResponse({ players: [MASKED, CLEARED], nextPageToken: 'tok' });
    expect(Object.prototype.hasOwnProperty.call(page.players[0]!, 'segment')).toBe(false);
    expect(page.players[1]!.segment).toBe('high-roller');
    // Empty means exhausted — a documented signal, not a default to drop.
    expect(page.nextPageToken).toBe('tok');
    expect(toPlayerPageResponse({ players: [], nextPageToken: '' }).nextPageToken).toBe('');
  });

  it('a page and a single read agree about the same record', () => {
    // The list must not have its own projection: the card and the row would then disagree about
    // whether a field exists.
    const [row] = toPlayerPageResponse({ players: [MASKED], nextPageToken: '' }).players;
    expect(row).toEqual(toPlayerResponse(MASKED));
  });

  it('an absent players array is an empty page, not a crash', () => {
    expect(toPlayerPageResponse({ nextPageToken: '' }).players).toEqual([]);
  });
});
