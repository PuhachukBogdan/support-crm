import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * ⭐ W32 / feature 039 (roadmap 12.11, research D3) — **FR-017 made structural: every fact on the
 * security page is READ, or it is honestly labelled as built into the product.**
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS TEST EXISTS. The security page is the easiest place in the whole product to lie, and
 * the lie is invisible. A row that says «ключи ограничены по адресам» looks EXACTLY the same whether
 * a query answered it a second ago or a developer typed it eighteen months ago and the setting was
 * turned off since. Nothing rots more quietly: the page keeps rendering, the tests keep passing, and
 * the sentence goes on being reassuring long after it stopped being true.
 *
 * That is worse than having no page. An absent fact leaves an administrator with an unknown risk,
 * which they can go and check. A stale fact converts it into a false assurance they ACT on.
 *
 * So the honesty is not a promise in a comment, it is a shape this scan can see:
 *   1. an entry with `kind: 'read'` carries a `read` whose body `await`s — a reader that awaits
 *      nothing is a constant wearing a reader's clothes, and it is exactly what a tired author
 *      writes when the query is inconvenient;
 *   2. an entry with `kind: 'built_in'` carries NO `read`, so «свойство продукта» and «настройка,
 *      которая включена» can never blur into each other;
 *   3. an entry with `kind: 'read'` carries no literal `value` — its value comes back from the query
 *      or it does not exist;
 *   4. the scan is ANTI-VACUOUS: it must FIND the registries and their rows. A structural guard that
 *      silently matched nothing is the failure this project has already paid for once (W31's log
 *      scan matched its own prose and reported success over zero files).
 *
 * ⓘ Comments are STRIPPED FIRST, then string literals are MASKED. Both for the same reason: this
 * file's own prose, and the registries' prose, contain every word the scan looks for. A detector that
 * reads its neighbours' explanations is a detector that always passes.
 *
 * ⓘ Known limit, stated rather than discovered: the masker understands quotes and template literals,
 * not regular-expression literals. No registry contains one; if one ever does, this note is where the
 * next reader starts.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

const ROOT = resolve(__dirname, '..', '..');

/** Every service that contributes facts declares them in exactly this path. */
function registryFiles(): { service: string; path: string }[] {
  const servicesDir = join(ROOT, 'services');
  return readdirSync(servicesDir)
    .map((service) => ({
      service,
      path: join(servicesDir, service, 'src', 'security', 'facts.registry.ts'),
    }))
    .filter((f) => existsSync(f.path));
}

/**
 * The escape character, spelled by its code point.
 *
 * ⓘ Not written as a literal on purpose: `tests/portability/no-hardcoded-path-separator.spec.ts`
 * bans a string whose entire content is one backslash, and pins its two legitimate holders BY NAME
 * so a third has to argue for itself. This lexer would be a perfectly good third — but the argument
 * costs a line there and nothing here, and a scanner has no business editing a guard.
 */
const ESCAPE = String.fromCharCode(92);

/**
 * Mark every character that sits INSIDE a string literal. `${…}` inside a template literal is code
 * and stays unmarked, so an `await` in an interpolation still counts as a real read.
 */
export function maskStrings(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false);
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === ESCAPE) mask[i++] = true;
        mask[i++] = true;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === ESCAPE) {
          mask[i++] = true;
          mask[i++] = true;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let braces = 1;
          while (i < src.length && braces > 0) {
            if (src[i] === '{') braces++;
            else if (src[i] === '}') braces--;
            i++;
          }
          continue;
        }
        mask[i++] = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return mask;
}

const OPEN = '{([';
const CLOSE = '})]';

/**
 * The `[...]` of `export const …SECURITY_FACTS … = [` — its inner span.
 *
 * ⚠️ The `[` is looked for after the `=`, not after the name. `readonly SecurityFactEntry[]` puts an
 * empty pair of brackets between the two, and taking that one yields an empty registry — a scan that
 * passes over nothing, which is precisely the vacuum this file's anti-vacuous test exists to catch.
 * It caught it here on the first run.
 */
function registrySpan(src: string, mask: boolean[]): { start: number; end: number } | null {
  const decl = /export\s+const\s+\w*SECURITY_FACTS\b/.exec(src);
  if (!decl) return null;
  let i = decl.index;
  while (
    i < src.length &&
    !(src[i] === '=' && !mask[i] && src[i + 1] !== '=' && src[i - 1] !== '=')
  )
    i++;
  while (i < src.length && !(src[i] === '[' && !mask[i])) i++;
  if (i >= src.length) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (mask[j]) continue;
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return { start: i + 1, end: j };
  }
  return null;
}

/** The inner span of every top-level `{ … }` in a region. */
function topLevelObjects(
  src: string,
  mask: boolean[],
  start: number,
  end: number,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  let objStart = -1;
  for (let i = start; i < end; i++) {
    if (mask[i]) continue;
    const c = src[i];
    if (c === '{' && depth === 0) objStart = i;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth === 0 && c === '}' && objStart !== -1) out.push({ start: objStart + 1, end: i });
    }
  }
  return out;
}

/** The properties written directly on one entry object — never those of a nested return value. */
function topLevelProps(
  src: string,
  mask: boolean[],
  start: number,
  end: number,
): Map<string, { start: number; end: number }> {
  const found: { name: string; nameAt: number; valueAt: number }[] = [];
  let depth = 0;
  let expectKey = true;
  let i = start;
  while (i < end) {
    if (mask[i]) {
      i++;
      continue;
    }
    const c = src[i];
    if (OPEN.includes(c)) {
      depth++;
      i++;
      continue;
    }
    if (CLOSE.includes(c)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === ',') {
        expectKey = true;
        i++;
        continue;
      }
      if (expectKey && /[A-Za-z_$]/.test(c)) {
        const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, end));
        if (m) {
          found.push({ name: m[1]!, nameAt: i, valueAt: i + m[0].length });
          expectKey = false;
          i += m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  const props = new Map<string, { start: number; end: number }>();
  found.forEach((p, idx) => {
    props.set(p.name, { start: p.valueAt, end: found[idx + 1]?.nameAt ?? end });
  });
  return props;
}

export interface EntryFacts {
  key: string;
  kind: string | null;
  hasRead: boolean;
  readAwaits: boolean;
  hasLiteralValue: boolean;
}

/** Parse one registry source into the four things this guard judges. */
export function inspectRegistry(source: string): EntryFacts[] {
  const src = stripComments(source);
  const mask = maskStrings(src);
  const span = registrySpan(src, mask);
  if (!span) return [];
  return topLevelObjects(src, mask, span.start, span.end).map((obj) => {
    const props = topLevelProps(src, mask, obj.start, obj.end);
    const kindSpan = props.get('kind');
    const kind = kindSpan
      ? (/['"](read|built_in)['"]/.exec(src.slice(kindSpan.start, kindSpan.end))?.[1] ?? null)
      : null;
    const keySpan = props.get('key');
    const readSpan = props.get('read');
    let readAwaits = false;
    if (readSpan) {
      for (const m of src.slice(readSpan.start, readSpan.end).matchAll(/\bawait\b/g)) {
        if (!mask[readSpan.start + m.index]) readAwaits = true;
      }
    }
    return {
      key: keySpan
        ? (/['"]([^'"]+)['"]/.exec(src.slice(keySpan.start, keySpan.end))?.[1] ?? '')
        : '',
      kind,
      hasRead: readSpan !== undefined,
      readAwaits,
      hasLiteralValue: props.has('value'),
    };
  });
}

/** The four rules, as sentences. An empty list means the registry is honest by construction. */
export function violations(entries: EntryFacts[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const at = e.key || '(unnamed entry)';
    if (e.kind === null)
      out.push(at + ': no kind — a fact must say whether it is read or built in');
    if (e.kind === 'read') {
      if (!e.hasRead) out.push(at + ": kind 'read' but no reader — nothing queries anything");
      else if (!e.readAwaits)
        out.push(at + ': the reader awaits nothing — a constant wearing a reader’s clothes');
      if (e.hasLiteralValue) out.push(at + ": kind 'read' carries a literal value");
    }
    if (e.kind === 'built_in') {
      if (e.hasRead) out.push(at + ": kind 'built_in' carries a reader — the two must not blur");
      if (!e.hasLiteralValue) out.push(at + ": kind 'built_in' states nothing");
    }
  }
  return out;
}

const REGISTRIES = registryFiles().map((f) => ({
  ...f,
  entries: inspectRegistry(readFileSync(f.path, 'utf8')),
}));

describe('the security page cannot be a typed checklist (W32 / 039, FR-017)', () => {
  it('⚠️ ANTI-VACUOUS — the scan finds both registries and their rows', () => {
    const services = REGISTRIES.map((r) => r.service).sort();
    expect(services).toEqual(expect.arrayContaining(['auth', 'chats']));
    expect(REGISTRIES.length).toBeGreaterThanOrEqual(2);
    for (const r of REGISTRIES) expect(r.entries.length).toBeGreaterThanOrEqual(2);
    // Both kinds must actually occur, or two of the four rules below judge nothing.
    const all = REGISTRIES.flatMap((r) => r.entries);
    // ⓘ The floors are TODAY'S counts (auth 9 read + 1 built-in, chats 2 + 1). Adding a fact never
    // trips them; removing one does, which is the point — a security fact should leave the product
    // on purpose and with somebody looking, not because a refactor took a query with it.
    expect(all.length).toBeGreaterThanOrEqual(13);
    expect(all.filter((e) => e.kind === 'read').length).toBeGreaterThanOrEqual(11);
    expect(all.filter((e) => e.kind === 'built_in').length).toBeGreaterThanOrEqual(2);
  });

  it.each(REGISTRIES.map((r) => [r.service, r] as const))(
    '%s: every fact is a real reader or an honest built-in',
    (_service, registry) => {
      // Repeated here on purpose: an empty list has no violations, and a green row over zero
      // entries is the exact reassurance this whole file refuses to give.
      expect(registry.entries.length).toBeGreaterThan(0);
      expect(violations(registry.entries)).toEqual([]);
    },
  );

  it('⭐ the detector is proved on PLANTED input — "no violations" means it looked', () => {
    const planted = `
      export const PLANTED_SECURITY_FACTS = [
        {
          key: 'typed.checklist',
          label: 'Contacts are masked',
          severity: 'critical',
          kind: 'read',
          value: 'enforced',
          read: async (ctx) => ({ state: 'ok', value: 'enforced' }),
        },
        {
          key: 'reader.that.reads.nothing',
          label: 'Something',
          severity: 'recommended',
          kind: 'read',
          read: async (ctx) => ({ state: 'ok', value: String(ctx.constant) }),
        },
        {
          key: 'built.in.with.a.reader',
          label: 'Built in',
          severity: 'informational',
          kind: 'built_in',
          value: SOME_CONSTANT,
          read: async (ctx) => { await ctx.db.thing.count(); return null; },
        },
      ];
    `;
    const found = violations(inspectRegistry(planted));
    expect(found).toHaveLength(4);
    expect(found.join('\n')).toContain('typed.checklist');
    expect(found.join('\n')).toContain('reader.that.reads.nothing');
    expect(found.join('\n')).toContain('built.in.with.a.reader');
  });

  it('the masker keeps its neighbours’ prose out of the scan', () => {
    // The word `await` inside a string must not make a reader look real.
    const src = `export const X_SECURITY_FACTS = [
      { key: 'k', kind: 'read', read: async (c) => ({ state: 'ok', value: 'we await nothing' }) },
    ];`;
    expect(violations(inspectRegistry(src))).toEqual([
      'k: the reader awaits nothing — a constant wearing a reader’s clothes',
    ]);
  });
});
