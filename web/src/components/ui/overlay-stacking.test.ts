import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⭐ **Every portalled overlay must sit above every sticky element.**
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────────
 * The operator opened the status filter on the Inbox and the list **rendered on top of it**. Cause:
 * this project defines a z-index scale in tokens — `sticky: 100 · dropdown: 200 · drawer: 300 ·
 * dialog: 400 · popover: 500` — and **every shadcn primitive shipped with a raw `z-50`**, which is
 * below `sticky`. The table header is the first sticky element in the product, so the Inbox is simply
 * where it surfaced first; the dialog, the sheet, the tooltip and the command palette all had it too.
 *
 * ── Why they all share ONE level instead of using the scale's separate values ────────────────────
 * ⚠️ A `Select` opened **inside** a `Dialog` is ordinary. If dropdowns were 200 and dialogs 400, that
 * select would render behind the dialog it belongs to. Radix portals each overlay to the end of
 * `<body>` as it opens, so with a shared z-index the **DOM order** stacks them correctly and nesting
 * works in any combination. The scale's intermediate values remain meaningful for *in-flow* stacking;
 * portalled overlays are one layer, above everything that is not.
 */
const UI_DIR = join(__dirname);
const OVERLAY_FILES = ['dialog.tsx', 'dropdown-menu.tsx', 'popover.tsx', 'select.tsx', 'sheet.tsx', 'tooltip.tsx'];

function read(file: string): string {
  return readFileSync(join(UI_DIR, file), 'utf8');
}

describe('the scan looks at real files (nothing below can pass vacuously)', () => {
  it('every overlay primitive exists and is non-trivial', () => {
    for (const file of OVERLAY_FILES) {
      expect(read(file).length).toBeGreaterThan(300);
    }
  });

  it('the ui directory holds more than just these', () => {
    expect(readdirSync(UI_DIR).filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(10);
  });
});

describe('*** portalled overlays stack above sticky content ***', () => {
  it('⭐ no overlay primitive uses a raw z-index class', () => {
    // `z-50` is below our `sticky` (100). A raw number here is how the token scale gets bypassed.
    const offenders = OVERLAY_FILES.filter((f) => /\bz-\d+\b|\bz-\[\d+/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('every overlay primitive uses the shared overlay token', () => {
    const missing = OVERLAY_FILES.filter((f) => !read(f).includes('z-popover'));
    expect(missing).toEqual([]);
  });

  it('the detector fires on the class that actually shipped', () => {
    expect(/\bz-\d+\b/.test('className="fixed z-50 rounded-md"')).toBe(true);
    expect(/\bz-\d+\b/.test('className="fixed z-popover rounded-md"')).toBe(false);
  });

  it('⚠️ and the token really is above sticky, in the token file itself', () => {
    // Asserting the ORDER, not the numbers: renumbering the scale must not silently re-break this.
    const tokens = readFileSync(join(UI_DIR, '..', '..', 'styles', 'tokens.css'), 'utf8');
    const value = (name: string) =>
      Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(tokens)?.[1] ?? NaN);
    expect(value('popover')).toBeGreaterThan(value('sticky'));
  });
});
