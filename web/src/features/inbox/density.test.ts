import { INBOX_COLUMNS, columnsForWidth } from './columns';

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
  it('is non-empty and every column declares a priority and a minimum width', () => {
    // Guards against a vacuous pass: an empty table would satisfy every assertion below.
    expect(INBOX_COLUMNS.length).toBeGreaterThan(4);
    for (const c of INBOX_COLUMNS) {
      expect(c.priority).toBeGreaterThanOrEqual(1);
      expect(c.minWidth).toBeGreaterThan(0);
      expect(c.header.length).toBeGreaterThan(0);
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

  it('at 2560 px every default column is present', () => {
    expect(columnsForWidth(WIDE).map((c) => c.id)).toEqual(INBOX_COLUMNS.map((c) => c.id));
  });

  it('at a narrow width the LOW-priority columns are the ones gone', () => {
    const kept = columnsForWidth(NARROW).map((c) => c.id);
    expect(kept.length).toBeLessThan(INBOX_COLUMNS.length);

    const droppedPriorities = INBOX_COLUMNS.filter((c) => !kept.includes(c.id)).map(
      (c) => c.priority,
    );
    const keptPriorities = INBOX_COLUMNS.filter((c) => kept.includes(c.id)).map((c) => c.priority);
    // Nothing kept may be lower-priority than something dropped.
    expect(Math.min(...droppedPriorities)).toBeGreaterThanOrEqual(Math.max(...keptPriorities));
  });

  it('⭐ the subject and status survive every width — a list without them is not a list', () => {
    for (const width of [2560, 1600, 1280, 1000, 600, 320]) {
      const kept = columnsForWidth(width).map((c) => c.id);
      expect(kept).toContain('subject');
      expect(kept).toContain('status');
    }
  });

  it('the kept columns always fit the width once anything is droppable', () => {
    for (const width of [2560, 1600, 1280, 1000]) {
      const total = columnsForWidth(width).reduce((sum, c) => sum + c.minWidth, 0);
      expect(total).toBeLessThanOrEqual(width);
    }
  });

  it('narrowing never ADDS a column back', () => {
    let previous = columnsForWidth(2560).length;
    for (const width of [2000, 1600, 1280, 1000, 800, 600]) {
      const count = columnsForWidth(width).length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });

  it('declared order is preserved among the survivors — dropping never reshuffles', () => {
    const kept = columnsForWidth(1280).map((c) => c.id);
    const expected = INBOX_COLUMNS.filter((c) => kept.includes(c.id)).map((c) => c.id);
    expect(kept).toEqual(expected);
  });
});
