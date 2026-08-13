import {
  categoryFromWire,
  categoryToWire,
  isStatusCategory,
  isTerminalCategory,
  NON_TERMINAL_CATEGORIES,
  SEEDED_STATUSES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_KEYS,
  TERMINAL_CATEGORIES,
  LEGACY_STATUS_MIGRATION,
} from './index';

/**
 * T018 (feature 032, roadmap 4.16 — ADR 0040) — the closed category catalogue.
 *
 * The membership is PINNED, like every other catalogue in this product (permissions 011, triggers 014,
 * audit actions 015, upload purposes 016, export scopes 017). Adding a category is then a visible edit to
 * a test rather than a quiet widening of what machine logic may branch on.
 */
describe('the six categories are closed and complete', () => {
  it('has exactly the ADR 0040 §1 membership, in workflow order', () => {
    expect([...STATUS_CATEGORY_KEYS]).toEqual([
      'new',
      'open',
      'pending',
      'on_hold',
      'solved',
      'closed',
    ]);
  });

  it('every category carries a label and a wire value; every wire value is distinct', () => {
    const wires = STATUS_CATEGORY_KEYS.map((k) => STATUS_CATEGORIES[k].wire);
    expect(new Set(wires).size).toBe(wires.length);
    for (const k of STATUS_CATEGORY_KEYS) {
      expect(STATUS_CATEGORIES[k].label.length).toBeGreaterThan(3);
      expect(STATUS_CATEGORIES[k].wire).toMatch(/^CONVERSATION_STATUS_CATEGORY_[A-Z_]+$/);
    }
  });

  it('refuses anything outside the catalogue — including the RETIRED status words', () => {
    for (const bad of ['resolved', 'snoozed', 'OPEN', 'on-hold', 'onhold', '', undefined, 7]) {
      expect(isStatusCategory(bad)).toBe(false);
    }
  });
});

describe('terminality — the one property anything branches on today', () => {
  it('solved and closed are terminal; the other four are not', () => {
    expect([...TERMINAL_CATEGORIES]).toEqual(['solved', 'closed']);
    expect([...NON_TERMINAL_CATEGORIES]).toEqual(['new', 'open', 'pending', 'on_hold']);
  });

  /**
   * ⚠️ The one that would have been a routing bug. `on_hold` covers `in_progress`, `follow_up`,
   * `auto_ended_chat` and `supervisor_review` — all work somebody is holding, none of them in the
   * `['open','pending']` list the load counters used before this feature.
   */
  it('ON_HOLD is NOT terminal — escalated work still occupies the agent holding it', () => {
    expect(isTerminalCategory('on_hold')).toBe(false);
    expect(isTerminalCategory('pending')).toBe(false);
  });

  it('an unknown category is not terminal — and that is fail-CLOSED here', () => {
    // Treating an unrecognised category as terminal would silently free capacity and remove tickets from
    // the rail. "Not finished" is the safe answer to "I do not know what this means".
    expect(isTerminalCategory('nonsense')).toBe(false);
    expect(isTerminalCategory('')).toBe(false);
  });
});

describe('the wire mapping round-trips, and refuses rather than guesses', () => {
  it('every category survives a round trip', () => {
    for (const k of STATUS_CATEGORY_KEYS) {
      expect(categoryFromWire(categoryToWire(k))).toBe(k);
    }
  });

  it('absent / UNSPECIFIED = no category asked for; an undefined member = null, never a guess', () => {
    expect(categoryFromWire(undefined)).toBeUndefined();
    expect(categoryFromWire('')).toBeUndefined();
    expect(categoryFromWire('CONVERSATION_STATUS_CATEGORY_UNSPECIFIED')).toBeUndefined();
    expect(categoryFromWire('CONVERSATION_STATUS_CATEGORY_SNOOZED')).toBeNull();
    // ⚠️ The RETIRED status enum is not a category enum, and must not accidentally decode as one.
    expect(categoryFromWire('CONVERSATION_STATUS_OPEN')).toBeNull();
  });

  it('a stored value outside the catalogue projects as UNSPECIFIED rather than as a category', () => {
    expect(categoryToWire('nonsense')).toBe('CONVERSATION_STATUS_CATEGORY_UNSPECIFIED');
    expect(categoryToWire('')).toBe('CONVERSATION_STATUS_CATEGORY_UNSPECIFIED');
  });
});

describe('the seeded set (ADR 0040 §3) is the workflow this team already has', () => {
  it('is the nine, each in a real category, with two names and a distinct key', () => {
    expect(SEEDED_STATUSES).toHaveLength(9);
    const keys = SEEDED_STATUSES.map((s) => s.key);
    expect(new Set(keys).size).toBe(9);
    for (const s of SEEDED_STATUSES) {
      expect(isStatusCategory(s.category)).toBe(true);
      expect(s.agentName.length).toBeGreaterThan(0);
      // U10: no consumer until Phase 6, populated anyway — dual naming cannot be retrofitted from data.
      expect(s.endUserName.length).toBeGreaterThan(0);
      expect(s.order).toBeGreaterThan(0);
    }
  });

  it('⭐ In progress shows the agent one thing and the player another — the point of two names', () => {
    const inProgress = SEEDED_STATUSES.find((s) => s.key === 'in_progress')!;
    expect(inProgress.category).toBe('on_hold');
    expect(inProgress.agentName).toBe('In progress');
    expect(inProgress.endUserName).toBe('Open');
  });

  it('⚠️ `closed` has NO seeded status — the category exists for 0041/0042, not for a row', () => {
    expect(SEEDED_STATUSES.some((s) => s.category === 'closed')).toBe(false);
    expect(isStatusCategory('closed')).toBe(true);
  });

  it('the display order is unique, so a list has one deterministic sequence', () => {
    const orders = SEEDED_STATUSES.map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('the migration of the shipped vocabulary (ADR 0040 §5)', () => {
  it('maps all FOUR shipped values, and every target is a seeded key — no row left unmapped', () => {
    expect(Object.keys(LEGACY_STATUS_MIGRATION).sort()).toEqual([
      'open',
      'pending',
      'resolved',
      'snoozed',
    ]);
    const keys = SEEDED_STATUSES.map((s) => s.key);
    for (const target of Object.values(LEGACY_STATUS_MIGRATION)) {
      expect(keys).toContain(target);
    }
  });

  it('`resolved` → `solved` and `snoozed` → `pending`, decided here rather than at migration time', () => {
    expect(LEGACY_STATUS_MIGRATION.resolved).toBe('solved');
    expect(LEGACY_STATUS_MIGRATION.snoozed).toBe('pending');
    // The two that keep their spelling keep their meaning too — asserted so a future edit cannot quietly
    // re-point them.
    expect(LEGACY_STATUS_MIGRATION.open).toBe('open');
    expect(LEGACY_STATUS_MIGRATION.pending).toBe('pending');
  });
});
