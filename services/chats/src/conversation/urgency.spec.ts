import { priorityRank, priorityWrite, UNRANKED, urgencyOrderParts } from './urgency';
import { ORDERS } from './conversation.repository';

/**
 * T035 (feature 031, roadmap 4.19/9.2b — FR-019, FR-020, SC-009) — the third order, and why it is a RANK.
 *
 * ⛔ Feature 029 shipped the Inbox with exactly TWO orders and refused a third, because nothing computed
 * urgency and *"a sort asserting a property the data lacks is a wrong answer nobody can see by looking"*.
 * These assertions are the receipt that the third order now says something true.
 */

describe('the priority RANK (FR-020)', () => {
  it('⭐ ranks by MEANING, and alphabetical order is a DIFFERENT order', () => {
    // The whole reason FR-020 exists. Our three priorities sort alphabetically as high < low < normal,
    // which is correct as strings and nonsense as urgency.
    const words = ['high', 'low', 'normal'];

    const alphabetical = [...words].sort();
    const byRank = [...words].sort((a, b) => priorityRank(b) - priorityRank(a));

    expect(alphabetical).toEqual(['high', 'low', 'normal']);
    expect(byRank).toEqual(['high', 'normal', 'low']);
    // ⭐ SC-009 asks for a case where the two DIFFER. `low` and `normal` swap places.
    expect(byRank).not.toEqual(alphabetical);
  });

  it('every priority the product can store has a rank, and they are distinct', () => {
    const ranks = ['low', 'normal', 'high'].map(priorityRank);
    expect(new Set(ranks).size).toBe(3);
    expect(ranks.every((r) => r > UNRANKED)).toBe(true);
  });

  it('⚠️ an unset priority ranks BELOW every set one, rather than being treated as normal', () => {
    // ~ a large share of rows have no priority at all. Guessing "normal" for them would promote
    // untriaged work above work somebody deliberately marked `low`, which is a decision the data does
    // not support. Unranked is its own floor.
    expect(priorityRank(null)).toBe(UNRANKED);
    expect(priorityRank(undefined)).toBe(UNRANKED);
    expect(priorityRank('')).toBe(UNRANKED);
    expect(priorityRank('low')).toBeGreaterThan(priorityRank(null));
  });

  it('⛔ an unrecognised word is UNRANKED, not ranked by guesswork', () => {
    // The column is free-form (feature 012 kept the *filter* free-form deliberately), so a value nothing
    // in the product understands can be in there. It must not be invented a position.
    expect(priorityRank('urgent')).toBe(UNRANKED);
    expect(priorityRank('P1')).toBe(UNRANKED);
  });
});

describe('the stored rank travels WITH the word (T036 half, FR-020)', () => {
  it('one call produces both fields, so a writer cannot set one and forget the other', () => {
    expect(priorityWrite('high')).toEqual({ priority: 'high', priority_rank: 3 });
  });

  it('clearing the priority clears the rank', () => {
    expect(priorityWrite(null)).toEqual({ priority: null, priority_rank: UNRANKED });
  });
});

describe('the declared urgency order (FR-019)', () => {
  it('⭐ is a DIFFERENT sequence from `updated_desc`, not a relabelling of it', () => {
    // If the third order resolved to the same columns and directions as an existing one, the screen would
    // gain an option that changes nothing — the "confidently wrong label" 029 refused, by another door.
    expect(ORDERS.urgency_desc).not.toEqual(ORDERS.updated_desc);
  });

  it('leads with the rank, and breaks ties by who has waited LONGEST', () => {
    expect(urgencyOrderParts()).toEqual([
      { column: 'priority_rank', direction: 'desc', type: 'int' },
      { column: 'updated_at', direction: 'asc', type: 'time' },
    ]);
  });

  it('⚠️ orders on the STORED rank column, never on the priority word', () => {
    // Ordering on `priority` would be the alphabetical sort FR-020 forbids, and it would look right in
    // a review: `orderBy: { priority: 'desc' }` is perfectly plausible TypeScript.
    const columns = ORDERS.urgency_desc.map((p) => p.column);
    expect(columns).toContain('priority_rank');
    expect(columns).not.toContain('priority');
  });

  it('⭐ the sortable list is EXACTLY the orders the server implements — one more, not two', () => {
    expect(Object.keys(ORDERS).sort()).toEqual(
      ['created_desc', 'updated_desc', 'updated_asc', 'urgency_desc'].sort(),
    );
  });
});
