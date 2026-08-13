/**
 * Catalogue rules for the field-TYPE vocabulary (feature 037, roadmap 4.15 — W30).
 *
 * Membership is asserted as an exact list so that growing the vocabulary is a VISIBLE act (the
 * audit-catalogue precedent), and the helpers are proven fail-closed — an unknown type must be
 * refused, never defaulted, because a default here becomes a silently-accepted value shape.
 */
import {
  FIELD_TYPES,
  FIELD_TYPE_KEYS,
  isFieldType,
  isNumericFieldValue,
} from './field-types';

describe('field-type catalogue (037)', () => {
  it('holds exactly the four types, in declaration order', () => {
    expect([...FIELD_TYPE_KEYS]).toEqual(['dropdown', 'text', 'numeric', 'multiline']);
    expect(Object.keys(FIELD_TYPES).sort()).toEqual([...FIELD_TYPE_KEYS].sort());
  });

  it('marks dropdown — and only dropdown — as option-set-bearing', () => {
    const withOptions = FIELD_TYPE_KEYS.filter((k) => FIELD_TYPES[k].hasOptions);
    expect(withOptions).toEqual(['dropdown']);
  });

  it('gives every type a human label', () => {
    for (const key of FIELD_TYPE_KEYS) expect(FIELD_TYPES[key].label.trim()).not.toBe('');
  });

  it('isFieldType is fail-closed on the unknown, the empty and the non-string', () => {
    expect(isFieldType('dropdown')).toBe(true);
    expect(isFieldType('multiline')).toBe(true);
    expect(isFieldType('checkbox')).toBe(false); // not shipped — refuse, never default
    expect(isFieldType('Dropdown')).toBe(false); // case is part of the contract
    expect(isFieldType('')).toBe(false);
    expect(isFieldType(undefined)).toBe(false);
    expect(isFieldType(3)).toBe(false);
  });

  it('numeric acceptance: finite plain numbers only', () => {
    expect(isNumericFieldValue('493326361')).toBe(true);
    expect(isNumericFieldValue('-12.5')).toBe(true);
    expect(isNumericFieldValue(' 42 ')).toBe(true);
    expect(isNumericFieldValue('')).toBe(false);
    expect(isNumericFieldValue('  ')).toBe(false);
    expect(isNumericFieldValue('12abc')).toBe(false);
    expect(isNumericFieldValue('NaN')).toBe(false);
    expect(isNumericFieldValue('Infinity')).toBe(false);
  });
});
