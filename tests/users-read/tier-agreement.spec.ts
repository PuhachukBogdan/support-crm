import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FIELD_TIERS,
  ROLE_VISIBLE_TIERS,
  allowedFields,
  visibleTiersFor,
  type FieldTier,
} from '../../libs/common/src/policy/field-tiers';
import { maskPlayer } from '../../services/users/src/player/player.masking';
import { ROLE_DEFAULTS, ROLE_KEYS } from '../../services/auth/src/rbac/catalogue';
import { parseSchema, type Model } from '../data-model/schema-scan';

/**
 * T046 + T047 (feature 018, roadmap 5.1) — the tier policy, checked against the things it must agree with.
 *
 * ── Two jobs, deliberately in one file ───────────────────────────────────────────────────────────
 * They share a subject: the answer to "which customer fields may this role see". T046 pins a KNOWN
 * DISAGREEMENT between two mechanisms and makes it unshippable; T047 pins that the classification is
 * complete and fails closed. Splitting them would put the divergence and the reason it is currently
 * harmless in two files that could drift apart.
 *
 * ── ⚠️ WHAT T046 IS NOT ──────────────────────────────────────────────────────────────────────────
 * It does **not** resolve research finding R3. R3 is a policy question about staff access to customer
 * contact data and belongs where those fields actually arrive (roadmap 5.4 / 5.5, the GR8 projection).
 * What this does is make the conflict **unreachable-and-guarded**: it holds today because nothing serves
 * a `masked_pii` field, and the build breaks the moment something does. Claiming otherwise would close a
 * finding on the strength of a coincidence.
 */
const ROOT = resolve(__dirname, '..', '..');
const PROTO = resolve(ROOT, 'libs/proto/crm/users/v1/users.proto');
const WIRE_MAPPER = resolve(ROOT, 'services/users/src/player/player.grpc.controller.ts');

const TIERS: readonly FieldTier[] = ['open', 'operational', 'am_only', 'masked_pii'];

/** Fields the policy classifies at the PII tier — derived, never listed here. */
const maskedPiiFields = (): string[] =>
  Object.entries(FIELD_TIERS)
    .filter(([, tier]) => tier === 'masked_pii')
    .map(([field]) => field);

/** Strip comments so a scan sees code, not prose about code. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** Field names declared by a `message X { … }` block in a .proto, in declaration order. */
function protoMessageFields(protoText: string, message: string): string[] {
  const block = new RegExp(`message\\s+${message}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(protoText);
  if (!block) throw new Error(`message ${message} not found in the contract`);
  const body = block[1]!
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const fields: string[] = [];
  // `[repeated|optional] <type> <name> = <n> [options];` — the name is the token before `=`.
  //
  // ⚠️ The trailing option group is NOT optional in this pattern by accident. Without it the scanner
  // silently skipped `repeated string brand_ids = 3 [deprecated = true];` and reported a contract
  // that was one field short — in a test whose own name promises nothing below it can pass vacuously.
  // A scanner that drops what it does not recognise makes every assertion downstream weaker than it
  // reads (feature 020).
  const re = /^\s*(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+\s*(?:\[[^\]]*\]\s*)?;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) fields.push(m[1]!);
  return fields;
}

const protoText = readFileSync(PROTO, 'utf8');
const mapperSource = readFileSync(WIRE_MAPPER, 'utf8');
const playerWireFields = protoMessageFields(protoText, 'Player');

describe('the scan reads the real artefacts (nothing below can pass vacuously)', () => {
  it('the contract parses and Player has the fields this feature shipped', () => {
    expect(playerWireFields).toEqual([
      'player_id',
      'account_id',
      'brand_ids',
      'vip',
      'segment',
      'am_notes',
      'custom_attributes_json',
      'preferences_json',
      'portfolio_json',
      // Feature 020 — the record's own brand, part of its identity. `brand_ids` above is deprecated
      // in place (kept for consumers that already read it) and now carries exactly one element.
      'brand_id',
      // Feature 022 — which HUMAN this record belongs to. DERIVED per read from `PersonMember`, not a
      // `Player` column, which is why the classification rule below had to grow a category for it.
      'person_id',
    ]);
  });

  it('the extractor sees a field carrying options (it did not, until feature 020)', () => {
    const fixture = [
      'message X {',
      '  string plain = 1;',
      '  repeated string annotated = 2 [deprecated = true];',
      '}',
    ].join('\n');
    expect(protoMessageFields(fixture, 'X')).toEqual(['plain', 'annotated']);
  });

  it('the field-name extractor ignores comments and takes the name, not the type', () => {
    const fixture = [
      'message T {',
      '  // string decoy = 9;',
      '  /* string other_decoy = 8; */',
      '  string real_one = 1;',
      '  repeated string many = 2;',
      '}',
    ].join('\n');
    expect(protoMessageFields(fixture, 'T')).toEqual(['real_one', 'many']);
  });

  it('the PII-tier derivation finds something (an empty set would disarm the gate)', () => {
    expect(maskedPiiFields()).toEqual(['gr8_snapshot']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * T046 — the R3 build gate
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('*** R3: two mechanisms DISAGREE about whether an AM may see customer PII ***', () => {
  /**
   * Recorded as a fact about the shipped product, not as a bug being fixed here.
   *
   * The disagreement is real and the two halves are both deliberate: the permission catalogue grants
   * `crm.contact.read_pii` to the AM roles (they manage the relationship), while the tier policy stops
   * their clearance at `am_only`. Which one is *right* is a product decision about staff access to
   * customer contact data — see roadmap 5.4/5.5. Pinning it here means the next person to notice finds a
   * test that already knows, instead of "fixing" one half and silently widening access.
   */
  const AM_ROLES = ['am', 'shift_am'] as const;

  it.each(AM_ROLES)('%s HOLDS the read-PII permission key', (role) => {
    expect(ROLE_DEFAULTS[role]).toContain('crm.contact.read_pii');
  });

  it.each(AM_ROLES)('%s is NOT cleared for the masked_pii tier', (role) => {
    expect(visibleTiersFor(role)).not.toContain('masked_pii');
    // …and stops exactly at am_only, so the divergence is one tier wide, not a wholesale mismatch.
    expect([...visibleTiersFor(role)]).toEqual(['open', 'operational', 'am_only']);
  });

  it('the roles that ARE cleared for masked_pii hold the key too (so only AM diverges)', () => {
    for (const role of ['admin', 'super_admin']) {
      expect(visibleTiersFor(role)).toContain('masked_pii');
    }
    // The divergence is exactly the AM pair — asserted so a third diverging role cannot appear unnoticed.
    const diverging = ROLE_KEYS.filter(
      (role) =>
        (ROLE_DEFAULTS[role] ?? []).includes('crm.contact.read_pii') &&
        !visibleTiersFor(role).includes('masked_pii'),
    );
    expect(diverging.sort()).toEqual(['am', 'shift_am']);
  });
});

describe('*** THE GATE: no masked_pii field may reach the wire while R3 is unresolved ***', () => {
  /**
   * Why the assertion lives at the WIRE and not at the masking function: `maskPlayer` KEEPS a
   * `masked_pii` field for admin/super_admin — they are cleared for it, so a row-layer assertion would
   * fail for the broadest roles and would tell us nothing about what a client actually receives. The
   * contract is what withholds the snapshot, so the contract is where the guarantee is checked.
   */
  it('the Player message declares no field for any PII-tier column', () => {
    const served = maskedPiiFields().filter((field) =>
      playerWireFields.some((wire) => wire === field || wire === `${field}_json`),
    );

    // Reported with the pointer rather than as a bare inequality: a failure here is not "delete this
    // field", it is "R3 has to be answered before this field can exist".
    expect({
      servedPiiFields: served,
      thenResolveFirst: served.length ? 'research R3 (roadmap 5.4/5.5) — AM clearance vs read_pii' : 'n/a',
    }).toEqual({ servedPiiFields: [], thenResolveFirst: 'n/a' });
  });

  it('*** the row → wire mapping is an EXPLICIT field list, never a spread ***', () => {
    const mapper = code(mapperSource);
    // A `...masked` would serve every field the role is cleared for — including the snapshot for
    // admin/super_admin — with every other test in this feature still green. This is the actual
    // mechanism the guarantee above rests on.
    expect(mapper).not.toMatch(/\.\.\.\s*masked\b/);
    expect(mapper).not.toMatch(/\.\.\.\s*row\b/);
    expect(mapper).not.toMatch(/Object\.assign\s*\(\s*\{\s*\}\s*,\s*masked/);
  });

  it('the mapper never reads a PII-tier field by name', () => {
    const mapper = code(mapperSource);
    for (const field of maskedPiiFields()) {
      expect(mapper).not.toContain(`masked.${field}`);
      expect(mapper).not.toContain(`row.${field}`);
    }
  });

  it('the predicate detects a spread when there is one (so the check is not decorative)', () => {
    const bad = 'function toPlayerWire(masked) { return { ...masked, accountId: a }; }';
    expect(code(bad)).toMatch(/\.\.\.\s*masked\b/);
    // …and is not fooled by a comment mentioning one.
    expect(code('// never write { ...masked } here')).not.toMatch(/\.\.\.\s*masked\b/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * T047 — classification completeness, and what an unclassified field does
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('*** every customer field is classified, in exactly one tier ***', () => {
  const player: Model = (() => {
    const found = parseSchema('users').find((m) => m.name === 'Player');
    if (!found) throw new Error('Player model not found in the users schema');
    return found;
  })();

  /**
   * `account_id` is deliberately NOT classified: it is the caller's own tenant, i.e. context rather
   * than customer data, and it is mapped outside the masking step. Adding it to the tier map would give
   * a tenancy value a clearance level it has no business having. It is named here so the exemption is a
   * decision with one place to change, not a hole.
   */
  const CONTEXT_NOT_CUSTOMER_DATA = [
    'account_id',
    // Feature 020 — RELATIONS, not customer fields, and never serialized to the wire.
    // `contact_matches` holds salted hashes and no plaintext, so there is nothing to classify;
    // `person_links` holds membership (which person, which kind of identifier), never a value.
    // Classifying them would give the tier map entries that name no customer data.
    'contact_matches',
    'person_links',
  ];

  it('the Player columns split into exactly {classified} ∪ {context}', () => {
    const columns = player.fields.map((f) => f.name);
    const unclassified = columns.filter((c) => !(c in FIELD_TIERS));
    expect(unclassified.sort()).toEqual([...CONTEXT_NOT_CUSTOMER_DATA].sort());
  });

  it('every classified field carries a legal tier', () => {
    for (const [field, tier] of Object.entries(FIELD_TIERS)) {
      expect({ field, legal: TIERS.includes(tier) }).toEqual({ field, legal: true });
    }
  });

  /**
   * ⚠️ **WIDENED by feature 022 (roadmap 4.13), and the widening is the interesting part.**
   *
   * The rule was "every classified field is a real `Player` column". Feature 022 added the first
   * classified field that is **not a column**: `person_id` is DERIVED on read from `PersonMember`
   * (which human this brand-scoped record belongs to) and served on the wire.
   *
   * It cannot simply be left unclassified — `allowedFields` filters `FIELD_TIERS`, so an unclassified
   * field is served to NOBODY, including `super_admin` (the case this file proves a few blocks below).
   * So a served-but-derived field MUST be classified, and this rule has to admit that category.
   *
   * It admits it EXPLICITLY, one name at a time. The point of the original rule survives intact: a
   * renamed column leaving a stale classification behind still fails here, because the stale name would
   * be neither a column nor on this list.
   */
  const DERIVED_SERVED_FIELDS = [
    // Feature 022: resolved from `PersonMember.@@unique([account_id, brand_id, player_id])` per read,
    // never stored on `Player`. Tier `open` — identity, not contact data.
    'person_id',
  ];

  it('the tier map classifies nothing that is not a real column, a relation, or a declared derived field', () => {
    const columns = new Set(player.fields.map((f) => f.name));
    for (const field of Object.keys(FIELD_TIERS)) {
      const known = columns.has(field) || DERIVED_SERVED_FIELDS.includes(field);
      expect({ field, known }).toEqual({ field, known: true });
    }
  });

  it('every declared derived field is actually served on the wire (no stale entry)', () => {
    // The other half of the exemption: a derived field that stops being served must be removed from
    // both lists, or the exemption would keep excusing a classification that governs nothing — the
    // exact failure the rule above exists to catch, re-entering through its own escape hatch.
    for (const field of DERIVED_SERVED_FIELDS) {
      expect({ field, onTheWire: playerWireFields.includes(field) }).toEqual({
        field,
        onTheWire: true,
      });
    }
  });

  it('every role in the permission catalogue has a tier clearance (no silent fallback in practice)', () => {
    // `visibleTiersFor` falls back to open-only for an unknown role, which is the right default — but a
    // role shipped in the catalogue reaching production WITHOUT a deliberate clearance is a decision
    // nobody made. Fail closed AND notice.
    for (const role of ROLE_KEYS) {
      expect({ role, classified: role in ROLE_VISIBLE_TIERS }).toEqual({ role, classified: true });
    }
  });
});

describe('*** an UNCLASSIFIED field is invisible to every role — verified by adding one ***', () => {
  /**
   * The property the corrected comment in `field-tiers.ts` now states (T047a). The old comment claimed an
   * unclassified field "defaults to masked_pii", i.e. stayed visible to the PII-cleared tiers. It never
   * did: `allowedFields` filters the tier map, so a field absent from the map is in no role's allow-list.
   *
   * Verified by actually masking a row that carries an unknown column, for EVERY role including the
   * broadest — because "invisible to everyone" is exactly the claim that a super-admin test would
   * disprove if it were wrong.
   */
  const row = {
    player_id: 'ply-1',
    vip: true,
    am_notes: 'note',
    gr8_snapshot: { surname: 'Doe', phone: '+100000000' },
    // The new column somebody forgot to classify:
    loyalty_rank: 'gold',
  };

  it.each([...ROLE_KEYS, 'some_new_role', ''])('%s cannot see the unclassified field', (role) => {
    // ⭐ Feature 026 added a required attachment argument. `true` here, deliberately: the property
    // under test is that an UNCLASSIFIED field is invisible to everyone, and the most demanding case
    // is the most privileged one. If it stays hidden from an attached AM, it stays hidden.
    const masked = maskPlayer(row, role, { attachedToSubject: true });
    expect(Object.keys(masked)).not.toContain('loyalty_rank');
    expect('loyalty_rank' in masked).toBe(false);
  });

  it('super_admin — the broadest clearance — cannot see it either', () => {
    // Stated separately because this is the assertion that distinguishes the real behaviour from the
    // behaviour the old comment described.
    expect(allowedFields('super_admin', { attachedToSubject: true }).has('loyalty_rank')).toBe(false);
    expect(Object.keys(maskPlayer(row, 'super_admin', { attachedToSubject: true }))).not.toContain('loyalty_rank');
  });

  it('…while the fields that ARE classified still come through for a cleared role', () => {
    // The counterweight: a fail-closed default is only interesting if the open path still works, else the
    // test above would pass on a masking function that returns nothing at all.
    const masked = maskPlayer(row, 'super_admin', { attachedToSubject: true });
    expect(Object.keys(masked).sort()).toEqual(['am_notes', 'gr8_snapshot', 'player_id', 'vip']);
  });

  it('a linear role sees only the open tier, and withheld fields are ABSENT not null', () => {
    const masked = maskPlayer(row, 'support_agent', { attachedToSubject: true });
    expect(Object.keys(masked)).toEqual(['player_id']);
    expect('am_notes' in masked).toBe(false);
    expect('gr8_snapshot' in masked).toBe(false);
  });
});
