/**
 * The fail-closed direction is the whole point of this helper, so it is asserted first and by
 * contrast with the outbound guard that deliberately defaults the other way (feature 038, SEC-PV1).
 */
import { parseIpAllowList, isAddressAllowed, clientAddressFrom } from './ip-allow-list';
import { parseHostAllowList, isHostAllowed } from '../mail/guards';

describe('inbound address allow-list (038)', () => {
  it('⚠️ AN EMPTY LIST DENIES — the opposite of the outbound mail guard, on purpose', () => {
    expect(isAddressAllowed('203.0.113.7', [])).toBe(false);
    // …and the contrast, stated as an executable fact rather than a comment: the egress guard
    // treats an empty list as «no restriction», because it narrows a legitimate outbound path.
    expect(isHostAllowed('smtp.example.test', parseHostAllowList(''))).toBe(true);
  });

  it('an unknown or blank caller address denies, even with a populated list', () => {
    const list = ['203.0.113.7'];
    expect(isAddressAllowed(undefined, list)).toBe(false);
    expect(isAddressAllowed('', list)).toBe(false);
    expect(isAddressAllowed('   ', list)).toBe(false);
    expect(isAddressAllowed('198.51.100.9', list)).toBe(false);
  });

  it('allows an exact match, case- and space-insensitively', () => {
    expect(isAddressAllowed(' 203.0.113.7 ', ['203.0.113.7'])).toBe(true);
    expect(isAddressAllowed('2001:DB8::1', ['2001:db8::1'])).toBe(true);
  });

  it('an IPv6-mapped IPv4 caller matches the v4 form a human typed', () => {
    expect(isAddressAllowed('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true);
  });

  it('parsing accepts a comma string or an array, drops blanks and duplicates', () => {
    expect(parseIpAllowList(' 203.0.113.7 , ,203.0.113.7, 198.51.100.9 ')).toEqual([
      '203.0.113.7',
      '198.51.100.9',
    ]);
    expect(parseIpAllowList(undefined)).toEqual([]);
  });

  it('⭐ the client address comes from the LAST forwarded entry — a client cannot spoof its way in', () => {
    // The chain a hostile client can influence is on the left; our own edge appends the real peer.
    expect(clientAddressFrom('203.0.113.7, 198.51.100.9', '10.0.0.1')).toBe('198.51.100.9');
    expect(clientAddressFrom(undefined, '10.0.0.1')).toBe('10.0.0.1');
    expect(clientAddressFrom('', undefined)).toBe('');
  });

  it('a spoofed left-hand entry does not grant access when the real peer is not listed', () => {
    const list = ['203.0.113.7'];
    const claimed = clientAddressFrom('203.0.113.7, 198.51.100.9', '198.51.100.9');
    expect(isAddressAllowed(claimed, list)).toBe(false);
  });
});
