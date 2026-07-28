import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  EXPORT_SCOPES,
  EXPORT_SCOPE_NAMES,
  type ExportScope,
} from '../../libs/common/src/exports/scopes';
import { canMassExportContacts } from '../../libs/common/src/policy/field-tiers';

/**
 * T045 (feature 017, US3) — the **SEC-AP2 build gate** (FR-009 / research R13).
 *
 * ── What this test is and is not ─────────────────────────────────────────────────────────────────
 * It does **not** close SEC-AP2. No v1 scope carries player contact fields, so the anti-pitching guard
 * feature 011 built and unit-tested still has no live surface, and this feature says so plainly rather
 * than claiming otherwise. What it does is make the guard **unforgettable**: the day somebody adds a
 * `players` scope, the build breaks unless the export path consults the policy.
 *
 * ── Why a conditional assertion needs its own tests ──────────────────────────────────────────────
 * "If a contact-bearing scope exists, the gate must be present" is vacuously true today — and a
 * vacuously-true guard is indistinguishable from a broken one. So the predicate is written out, and both
 * of its halves are exercised against fixtures. The gate that matters is tested; the catalogue it reads
 * is merely empty for now.
 *
 * ⚠️ The gate is on **`canMassExportContacts` from `@crm/common`**, not on `assertCanMassExport`. The
 * throwing wrapper is `services/users/src/player/player.masking.ts` and the export path lives in `chats`
 * — importing it across services would fail the existing no-cross-service-import scan (Principle VIII).
 * The POLICY is shared; only the wrapper is users-local.
 */
const ROOT = resolve(__dirname, '..', '..');
const EXPORT_PATH = 'services/chats/src/export';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** True when the catalogue contains a scope that may carry player contact fields. */
function requiresContactGate(scopes: Record<string, ExportScope>): boolean {
  return Object.values(scopes).some((s) => s.mayContainContactData);
}

/** True when `source` actually consults the shared policy — a call, not a mention in prose. */
function consultsGate(source: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
  return /canMassExportContacts\s*\(/.test(code);
}

describe('the predicate itself works (so the gate below cannot pass vacuously)', () => {
  it('recognises a contact-bearing scope', () => {
    const fixture: Record<string, ExportScope> = {
      players: { ...EXPORT_SCOPES.conversations, mayContainContactData: true },
    };
    expect(requiresContactGate(fixture)).toBe(true);
  });

  it('does not fire on a scope that carries none', () => {
    expect(requiresContactGate({ x: EXPORT_SCOPES.conversations })).toBe(false);
  });

  it('sees a real call and ignores a comment about one', () => {
    expect(consultsGate('if (!canMassExportContacts(role)) throw new Error();')).toBe(true);
    expect(consultsGate('// one day this must call canMassExportContacts(roleKey)')).toBe(false);
    expect(consultsGate('/** canMassExportContacts is not consulted yet */')).toBe(false);
    expect(consultsGate('const x = 1;')).toBe(false);
  });
});

describe('*** THE GATE: a contact-bearing scope cannot exist without the policy check ***', () => {
  const exportSources = walk(join(ROOT, ...EXPORT_PATH.split('/')));

  it('the scan sees the export path (not silently empty)', () => {
    expect(exportSources.length).toBeGreaterThan(3);
    expect(exportSources.map((f) => f.slice(ROOT.length + 1).split(sep).join('/'))).toContain(
      `${EXPORT_PATH}/export.service.ts`,
    );
  });

  it('if any scope may carry contact data, the export path consults canMassExportContacts', () => {
    const gated = exportSources.some((f) => consultsGate(readFileSync(f, 'utf8')));
    const needed = requiresContactGate(EXPORT_SCOPES as unknown as Record<string, ExportScope>);

    // Reported as a pair so the failure message says WHICH half is wrong: a new contact scope with no
    // gate, rather than an opaque `false !== true`.
    expect({ needsGate: needed, gatePresent: needed ? gated : 'n/a' }).toEqual({
      needsGate: needed,
      gatePresent: needed ? true : 'n/a',
    });
  });
});

describe('*** no v1 scope carries contact data — so SEC-AP2 stays OPEN ***', () => {
  it('every scope declares mayContainContactData: false', () => {
    for (const name of EXPORT_SCOPE_NAMES) {
      expect({ name, mayContain: EXPORT_SCOPES[name].mayContainContactData }).toEqual({
        name,
        mayContain: false,
      });
    }
  });

  it('the v1 catalogue has exactly one scope, and it is conversations', () => {
    // Stated as a fact about the shipped catalogue: adding a second scope is a deliberate act that has to
    // update this test, which is the review moment where somebody asks about contact data.
    expect([...EXPORT_SCOPE_NAMES]).toEqual(['conversations']);
  });
});

describe('the shared policy is ready for the day it is needed', () => {
  it('an open-only (masked) role may NOT bulk-export contacts', () => {
    expect(canMassExportContacts('support_agent')).toBe(false);
  });

  it('roles that legitimately see contacts may', () => {
    expect(canMassExportContacts('vip_support')).toBe(true);
    expect(canMassExportContacts('am')).toBe(true);
  });

  it('an unknown role is refused — the fallback is open-only, not permissive', () => {
    // The fail-closed direction matters more than the allow list: a role added to the registry without a
    // tier mapping must not acquire bulk contact export by default.
    expect(canMassExportContacts('some_new_role')).toBe(false);
    expect(canMassExportContacts('')).toBe(false);
  });

  it('breadth of permissions does not decide it — the ROLE does', () => {
    // SEC-AP2's actual content: admin and super_admin are subject to the same question as everyone else,
    // and the answer comes from field tiers rather than from how many permission keys they hold.
    expect(canMassExportContacts('admin')).toBe(true);
    expect(canMassExportContacts('super_admin')).toBe(true);
    // …which is why the gate is a tier question, not a permission question. A role with every permission
    // and open-only tiers is still refused:
    expect(canMassExportContacts('support_agent')).toBe(false);
  });
});
