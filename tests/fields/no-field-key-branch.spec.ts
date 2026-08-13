import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — **NOTHING BRANCHES ON A FIELD KEY OR A FORM KEY.**
 *
 * ── The claim, and why it needs a scan ───────────────────────────────────────────────────────────
 * The two-level model only pays for itself if the machine reads the closed TYPE vocabulary
 * (`libs/common/src/fields/field-types.ts`) and treats every field, form and option set as rows.
 * The moment one function says `if (fieldKey === 'psp')`, adding a field stops being configuration
 * and becomes a deployment — the exact failure the operator's ~65 captured Zendesk fields exist to
 * avoid re-buying. Same guard family as statuses (032), channels (033), upload purposes (016).
 *
 * ── Scope: three trees, not one ──────────────────────────────────────────────────────────────────
 * chats validates, the gateway translates, web RENDERS — and a renderer that switches on a field
 * key is the same defect one screen later. The statuses guard scanned only chats because the keys
 * never reach web as behaviour; field keys do (the cascade), so the net is wider here.
 *
 * Comments are stripped first: a guard that bans a token from prose gets "fixed" by deleting the
 * explanation of why the token is banned.
 */
const ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOTS = [
  join(ROOT, 'services', 'chats', 'src'),
  join(ROOT, 'services', 'gateway', 'src'),
  join(ROOT, 'web', 'src'),
];
const SEED_FILE = join(ROOT, 'services', 'chats', 'prisma', 'seed.build.ts');
const MIGRATION_FILE = join(
  ROOT,
  'services',
  'chats',
  'prisma',
  'migrations',
  '20260812150000_ticket_fields',
  'migration.sql',
);

/**
 * Files exempt from the scan, each with a reason. ⚠️ The guard's own weak point — it stays tiny,
 * and every entry must be a file whose PURPOSE is to name fields rather than to react to them.
 */
const KEY_SCAN_EXEMPT: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip comments so the scan polices behaviour rather than vocabulary. */
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}
function codeOf(file: string): string {
  return strip(readFileSync(file, 'utf8'));
}

const rel = (abs: string) => abs.slice(ROOT.length + 1).split(sep).join('/');

/** Product code only: specs and RTL tests legitimately name keys to build a scenario. */
const SOURCES = SCAN_ROOTS.flatMap((root) => walk(root))
  .filter((f) => !/\.(spec|test)\.(ts|tsx)$/.test(f))
  .map((abs) => ({ path: rel(abs), code: codeOf(abs) }));

/**
 * The distinctive SEEDED identities (T034, `services/chats/prisma/seed.build.ts`). Hardcoded here
 * and cross-checked against the seed below, so the list cannot drift from what actually ships.
 * `country` / `psp` are seeded too but excluded from the scan for collision risk the statuses guard
 * documented for `open`: short common words report vocabulary, not behaviour — the six that remain
 * are exactly the keys a branch would want to name.
 */
const DISTINCTIVE_FIELD_KEYS = [
  'type_of_contact',
  'user_level',
  'l1_deposits',
  'l2_deposit_status',
  'l3_deposit_declined',
];
const DISTINCTIVE_FORM_KEYS = ['ghost_contact', 'vip_topics', 'promotions_and_bonus'];

describe('the scan sees the product (nothing below can pass by scanning nothing)', () => {
  it('reads a plausible number of files across all three trees', () => {
    expect(SOURCES.length).toBeGreaterThan(150);
    for (const path of [
      'services/chats/src/conversation/conversation.repository.ts',
      'services/gateway/src/chats/wire.ts',
      'web/src/features/ticket/fields-column.tsx',
    ]) {
      expect(SOURCES.map((s) => s.path)).toContain(path);
    }
  });

  it('the predicate fires on a real branch and stays quiet on ordinary code', () => {
    const fires = (code: string) => /['"`]type_of_contact['"`]/.test(code);
    expect(fires("if (fieldKey === 'type_of_contact') return special();")).toBe(true);
    expect(fires('if (FIELD_TYPES[def.type].hasOptions) return options;')).toBe(false);
  });

  it('comment-stripping is in the pipeline (a banned token in prose is not an offence)', () => {
    const prose = "// the l1_deposits cascade is documented here\nconst ok = 1;";
    expect(prose).toContain('l1_deposits'); // the raw text does carry it…
    expect(strip(prose)).not.toContain('l1_deposits'); // …and the scan's view does not.
  });

  it('the exemption list is SHORT — a long one would make this guard decorative', () => {
    expect(KEY_SCAN_EXEMPT.length).toBeLessThanOrEqual(2);
  });

  it('the scanned keys are the SEEDED keys — the list cannot drift from the product', () => {
    const seed = readFileSync(SEED_FILE, 'utf8');
    for (const key of [...DISTINCTIVE_FIELD_KEYS, ...DISTINCTIVE_FORM_KEYS]) {
      expect({ key, seeded: seed.includes(`'${key}'`) }).toEqual({ key, seeded: true });
    }
  });
});

describe('*** no field key and no form key is a literal in product code ***', () => {
  it.each([...DISTINCTIVE_FIELD_KEYS, ...DISTINCTIVE_FORM_KEYS])(
    'no file names `%s`',
    (key) => {
      const pattern = new RegExp(`['"\`]${key}['"\`]`);
      const offenders = SOURCES.filter(
        (s) => !KEY_SCAN_EXEMPT.includes(s.path) && pattern.test(s.code),
      ).map((s) => s.path);
      expect(offenders).toEqual([]);
    },
  );
});

describe('*** the constraints the schema comment can only promise live in the migration SQL ***', () => {
  const sql = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';

  it('the migration exists', () => {
    expect(sql).not.toBe('');
  });

  it('⭐ at most ONE sub-category source per form is a PARTIAL UNIQUE INDEX, not a convention', () => {
    // Prisma cannot express a conditional unique (the feature-026 precedent), so the model comment
    // points here and THIS assertion is what keeps the promise from silently disappearing in a
    // future squash: unique, on form_id, filtered to the designated rows.
    const stripped = sql.replace(/--.*$/gm, '');
    expect(stripped).toMatch(
      /CREATE UNIQUE INDEX "FormField_one_subcategory_source_per_form"\s*\n?\s*ON "FormField"\("form_id"\)\s*\n?\s*WHERE "is_subcategory_source"/,
    );
  });

  it('the form choice is a COMPOSITE FK to the per-account key (the status_def shape)', () => {
    expect(sql).toContain('FOREIGN KEY ("account_id", "form_key") REFERENCES "Form"("account_id", "key")');
  });
});
