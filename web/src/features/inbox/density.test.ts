import type { ColumnDef } from '@tanstack/react-table';
import { columnsThatFit } from '@/components/composites/data-table';
import { INBOX_COLUMNS } from './columns';

/**
 * The screen's declaration, in the shape the composite consumes — exactly what `inbox-list.tsx` builds.
 *
 * ⚠️ **The shedding assertions below now run through the COMPOSITE.** They used to call a
 * `columnsForWidth()` that lived in this folder, which is the layering violation `density-spec.md` §7
 * records against feature 029. Keeping the assertions here and moving the mechanism there is deliberate:
 * the rule belongs to S2, but *this screen's* outcome under it is what the operator sees.
 */
const defs: ColumnDef<Record<string, unknown>, unknown>[] = INBOX_COLUMNS.map((c) => ({
  id: c.id,
  size: c.width,
  meta: { tier: c.tier },
}));

/** Ids the composite keeps at `width`, with no optional column opted into. */
const keptAt = (width: number) => columnsThatFit(defs, width).map((c) => c.id);

/** Everything except the optional tier — the default set, since optional is off unless opted into. */
const DEFAULT_IDS = INBOX_COLUMNS.filter((c) => c.tier !== 'optional').map((c) => c.id);

/**
 * T028 (feature 029, FR-005/FR-006) — density as a **testable rule**, not a look.
 *
 * The operator's complaint is specific and repeated: *«страница слишком растянута»*, on a 2K monitor,
 * and cross-cutting conclusion **A** makes density a requirement rather than taste. A requirement
 * needs an assertion, and "looks dense" is not one. A declared priority gives us: *at 2560 px every
 * default column is present; at 1280 px exactly these are gone.*
 *
 * ⚠️ **jsdom has no layout**, so this file cannot prove a single pixel. It asserts the SELECTION
 * RULE. Whether the chosen columns actually fit without a horizontal scrollbar is measured in a real
 * browser — quickstart B6 — and if that cannot run it must report itself as not-run rather than pass
 * quietly.
 */
describe('the column priority table is well formed', () => {
  it('is non-empty and every column declares one of the three tiers and a width', () => {
    // Guards against a vacuous pass: an empty table would satisfy every assertion below.
    expect(INBOX_COLUMNS.length).toBeGreaterThan(4);
    for (const c of INBOX_COLUMNS) {
      // The three named tiers of density-spec §2 — never an invented number, which is what these were.
      expect(['essential', 'contextual', 'optional']).toContain(c.tier);
      expect(c.width).toBeGreaterThan(0);
      expect(c.header.length).toBeGreaterThan(0);
    }
  });

  it('⭐ declares no breakpoint of its own — the composite decides what fits (§7)', () => {
    // Structural, because the violation was not a wrong number but a decision in the wrong layer: the
    // screen measured `window.innerWidth` and ran its own `columnsForWidth`. A test of the OUTCOME
    // would have passed throughout — feature 029's did.
    const columns = INBOX_COLUMNS as unknown as readonly Record<string, unknown>[];
    for (const c of columns) {
      expect(c.priority).toBeUndefined();
      expect(c.minWidth).toBeUndefined();
    }
  });

  it('column ids are unique', () => {
    const ids = INBOX_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⭐ the column ORDER follows Zendesk (screenshots/views_1.png)', () => {
    // Status first, subject fifth — ours led with the subject. The operator's rule since 2026-08-03
    // is to reproduce the screenshot and adjust afterwards, so the order comes from the image.
    expect(INBOX_COLUMNS.map((c) => c.header)).toEqual([
      'Status',
      'Requested',
      'Updated',
      'Channel',
      'Player',
      'Subject',
      'Priority',
      'Assignee',
      'Category',
    ]);
  });

  it('⚠️ the update column is labelled "Updated", never "last activity" (R7)', () => {
    const col = INBOX_COLUMNS.find((c) => c.id === 'lastActivityAt');
    expect(col?.header).toBe('Updated');
    // The field is `updated_at`; our own relabelling and resolving bump it. "Activity" would claim
    // the customer did something — and would look right doing so.
    for (const c of INBOX_COLUMNS) expect(c.header).not.toMatch(/activity/i);
  });

  it('⚠️ the customer column is labelled "Player", never "Requester" (R9)', () => {
    const col = INBOX_COLUMNS.find((c) => c.id === 'playerId');
    expect(col?.header).toBe('Player');
    // The product stores no customer name at any tier. A column headed "Requester" holding an id
    // reads as a broken name; headed "Player" holding a player id, it is simply true.
    for (const c of INBOX_COLUMNS) expect(c.header).not.toMatch(/requester|customer name/i);
  });
});

describe('*** columns drop by priority, and the list never scrolls sideways (FR-006) ***', () => {
  const WIDE = 2560; // the operator's stated reference monitor
  const NARROW = 1000;

  it('at 2560 px every DEFAULT column is present — and `category` is not one of them', () => {
    expect(keptAt(WIDE)).toEqual(DEFAULT_IDS);
    // ⭐ The density spec always put category in the optional tier; it rendered anyway because the
    // screen had no way to say "optional". Now it does, so the default set is the spec's default set.
    expect(keptAt(WIDE)).not.toContain('category');
  });

  it('an optional column appears only when opted into', () => {
    expect(columnsThatFit(defs, WIDE, ['category']).map((c) => c.id)).toContain('category');
  });

  it('at a narrow width the CONTEXTUAL columns are the ones gone, never an essential one', () => {
    const kept = keptAt(NARROW);
    expect(kept.length).toBeLessThan(DEFAULT_IDS.length);
    const shedTiers = INBOX_COLUMNS.filter((c) => !kept.includes(c.id)).map((c) => c.tier);
    expect(shedTiers).not.toContain('essential');
  });

  it('⭐ the subject and status survive every width — a list without them is not a list', () => {
    for (const width of [2560, 1600, 1280, 1000, 600, 320]) {
      expect(keptAt(width)).toContain('subject');
      expect(keptAt(width)).toContain('status');
    }
  });

  it('the kept columns fit the width while anything is still sheddable', () => {
    for (const width of [2560, 1600, 1280, 1000]) {
      const total = columnsThatFit(defs, width).reduce(
        (sum, c) => sum + (typeof c.size === 'number' ? c.size : 0),
        0,
      );
      expect(total).toBeLessThanOrEqual(width);
    }
  });

  it('narrowing never ADDS a column back', () => {
    let previous = keptAt(2560).length;
    for (const width of [2000, 1600, 1280, 1000, 800, 600]) {
      const count = keptAt(width).length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });

  it('declared order is preserved among the survivors — shedding never reshuffles', () => {
    const kept = keptAt(1280);
    const expected = INBOX_COLUMNS.filter((c) => kept.includes(c.id)).map((c) => c.id);
    expect(kept).toEqual(expected);
  });

  it('⚠️ an unmeasured width means "not measured yet", not "no room"', () => {
    // Reading 0 as no room would shed every sheddable column on first paint and add them back after
    // the first measurement — a visible reflow on every mount.
    expect(keptAt(0)).toEqual(DEFAULT_IDS);
  });
});
