import {
  UPLOAD_PURPOSES,
  UPLOAD_PURPOSE_NAMES,
  isUploadPurpose,
  purposeOf,
  purposeAllowsType,
  shouldProduceDerivative,
} from './purposes';
import { DETECTABLE_CONTENT_TYPES, isRasterImage } from './content-type';
// Test-only import of the feature-011 permission registry. Safe in both directions: `catalogue.ts`
// has no imports of its own, so typechecking it here pulls nothing from the auth service, and this
// is a spec — it never ships inside `@crm/common`. The alternative, restating the key list here,
// is a second copy of a catalogue whose entire value is being the only one.
import { SYSTEM_CATALOGUE } from '../../../../services/auth/src/rbac/catalogue';

/**
 * T009 (feature 016) — the purpose catalogue is CLOSED, and every entry is answerable.
 *
 * The property under test is not "the values are right" but "there is no way to get limits nobody
 * chose". That is why the unknown-purpose cases assert `null` rather than a thrown error: a refusal
 * that callers must handle explicitly cannot be swallowed by a `catch` somewhere upstream, and a
 * `?? DEFAULT` added in a hurry would fail here rather than quietly widening the product.
 */
describe('the upload-purpose catalogue is closed (FR-002)', () => {
  it('an unknown purpose resolves to nothing — there is no permissive default', () => {
    for (const unknown of ['', 'nonsense', 'Message_Attachment', 'default', '__proto__', 'toString']) {
      expect(isUploadPurpose(unknown)).toBe(false);
      expect(purposeOf(unknown)).toBeNull();
    }
    expect(purposeOf(undefined)).toBeNull();
  });

  it('every registered name resolves, and the set is exactly what the module exports', () => {
    expect(UPLOAD_PURPOSE_NAMES.sort()).toEqual([
      'avatar',
      // Feature 033 (roadmap 6.1/6.4): a file that arrived on a channel. Its own row rather than
      // reusing `message_attachment`, because the writer is the intake path rather than a person —
      // reusing that row would hand a stranger's upload an agent's caps and an agent's permission
      // story. Tighter caps for the same reason: it is the one upload path an unauthenticated party
      // can reach.
      'channel_inbound_attachment',
      // Feature 017 (roadmap 4.10): the export artefact enters storage through the EXISTING
      // CreateUpload, so it is a row here rather than a second ingest path. That is the whole reason
      // the feature-016 structural test still passes with its `bytes`-message set unchanged.
      'conversation_export',
      'message_attachment',
    ]);
    for (const name of UPLOAD_PURPOSE_NAMES) {
      expect(purposeOf(name)).toBe(UPLOAD_PURPOSES[name]);
      expect(isUploadPurpose(name)).toBe(true);
    }
  });

  it('an inherited Object property is not a purpose (the catalogue is a lookup, not a prototype walk)', () => {
    // `'constructor' in UPLOAD_PURPOSES` is true; membership must not be. A purpose resolved this
    // way would be `undefined` at the call site and take whatever branch handles a falsy entry.
    expect(isUploadPurpose('constructor')).toBe(false);
    expect(purposeOf('valueOf')).toBeNull();
  });
});

describe('every entry is well-formed', () => {
  it.each(UPLOAD_PURPOSE_NAMES)('%s: names a real permission key, or explicitly null', (name) => {
    const { permission } = UPLOAD_PURPOSES[name];
    if (permission === null) return; // explicit "authenticated is sufficient" — see R11.
    expect(SYSTEM_CATALOGUE.map((e) => e.key)).toContain(permission);
  });

  it.each(UPLOAD_PURPOSE_NAMES)('%s: has a positive cap', (name) => {
    expect(UPLOAD_PURPOSES[name].maxBytes).toBeGreaterThan(0);
  });

  /**
   * The allow-list rule now depends on ORIGIN, and the split is the point (feature 017 / research R5).
   *
   * An `ingested` purpose MUST list types: it accepts bytes from someone else, and the detection table
   * is what decides whether to believe them. A `produced` purpose must list NONE: its bytes come from
   * our own serializer, and CSV has no magic number — so listing `text/csv` would have meant adding an
   * unverifiable type to the shared detection table, where any future untrusted purpose could then use
   * it. An empty list here reads correctly as "no ingested type is acceptable for this purpose".
   */
  it.each(UPLOAD_PURPOSE_NAMES)('%s: allow-list matches its origin', (name) => {
    const p = UPLOAD_PURPOSES[name];
    if (p.origin === 'ingested') {
      expect(p.types.length).toBeGreaterThan(0);
      expect(p.derivativeLongestEdge).toBeGreaterThan(0);
    } else {
      expect(p.types).toEqual([]);
      expect(p.derivative).toBe('never');
    }
  });

  it('exactly one purpose is `produced`, exactly one is `ephemeral`, and they are the SAME one', () => {
    const produced = UPLOAD_PURPOSE_NAMES.filter((n) => UPLOAD_PURPOSES[n].origin === 'produced');
    const ephemeral = UPLOAD_PURPOSE_NAMES.filter((n) => UPLOAD_PURPOSES[n].ephemeral);
    expect(produced).toEqual(['conversation_export']);
    expect(ephemeral).toEqual(produced);
  });

  it('*** no INGESTED purpose is ephemeral — that pairing would delete a live avatar ***', () => {
    // The 016 catalogue already warns that a future reclaim job would collect `pending` uploads and
    // therefore delete avatars in active use. `ephemeral` is the flag such a job would key on, so the
    // two facts must never meet on one row. Cheap to assert now; silent data loss to discover later.
    for (const name of UPLOAD_PURPOSE_NAMES) {
      const p = UPLOAD_PURPOSES[name];
      expect({ name, bad: p.origin === 'ingested' && p.ephemeral }).toEqual({ name, bad: false });
    }
  });

  it('`text/csv` is absent from the shared detection table (the table did NOT change)', () => {
    // Feature 017 chose provenance over a new signature precisely so this stays true.
    expect(DETECTABLE_CONTENT_TYPES as readonly string[]).not.toContain('text/csv');
  });

  it.each(UPLOAD_PURPOSE_NAMES)('%s: every allowed type is one the content check can detect', (name) => {
    // A type nothing can detect from its bytes is a type that can never be accepted (FR-006), so
    // listing one would be a permission that reads as granted and behaves as denied.
    for (const type of UPLOAD_PURPOSES[name].types) {
      expect(DETECTABLE_CONTENT_TYPES).toContain(type);
    }
  });

  it.each(UPLOAD_PURPOSE_NAMES)('%s: SVG and other active-document formats are absent (FR-005)', (name) => {
    for (const forbidden of ['image/svg+xml', 'text/html', 'application/xml', 'text/xml']) {
      expect(UPLOAD_PURPOSES[name].types as readonly string[]).not.toContain(forbidden);
    }
  });

  it('*** a purpose claiming `always` allows ONLY image types ***', () => {
    // This is the job the `always` value does. Its runtime behaviour matches `images-only`; the
    // difference is a claim that "no derivative" cannot happen for this purpose. Adding a PDF to an
    // `always` purpose would silently make that claim false — here it fails the build instead.
    for (const name of UPLOAD_PURPOSE_NAMES) {
      const p = UPLOAD_PURPOSES[name];
      if (p.derivative !== 'always') continue;
      expect({ name, nonImages: p.types.filter((t) => !isRasterImage(t)) }).toEqual({
        name,
        nonImages: [],
      });
    }
  });
});

describe('the avatar entry matches ADR 0035 exactly', () => {
  const avatar = UPLOAD_PURPOSES.avatar;

  it('2 MB, PNG/JPEG/WebP, SVG excluded', () => {
    expect(avatar.maxBytes).toBe(2 * 1024 * 1024);
    expect([...avatar.types].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(avatar.types as readonly string[]).not.toContain('image/svg+xml');
  });

  it('is self-service: permission is explicitly null, not a key nobody holds', () => {
    expect(avatar.permission).toBeNull();
  });

  it('produces a derivative — ADR 0035 open item 3, closed by this feature', () => {
    expect(avatar.derivative).toBe('always');
    expect(shouldProduceDerivative(avatar, 'image/png')).toBe(true);
  });
});

describe('derivative policy reads the catalogue, never a purpose name', () => {
  const attachment = UPLOAD_PURPOSES.message_attachment;

  it('an image attachment gets a derivative; a PDF attachment does not', () => {
    expect(shouldProduceDerivative(attachment, 'image/jpeg')).toBe(true);
    expect(shouldProduceDerivative(attachment, 'image/gif')).toBe(true);
    expect(shouldProduceDerivative(attachment, 'application/pdf')).toBe(false);
  });

  it('a `never` policy produces nothing even for an image', () => {
    const none = { ...attachment, derivative: 'never' as const };
    expect(shouldProduceDerivative(none, 'image/png')).toBe(false);
  });
});

describe('type membership is per purpose', () => {
  it('a PDF is an attachment but never an avatar', () => {
    expect(purposeAllowsType(UPLOAD_PURPOSES.message_attachment, 'application/pdf')).toBe(true);
    expect(purposeAllowsType(UPLOAD_PURPOSES.avatar, 'application/pdf')).toBe(false);
  });

  it('a GIF is an attachment but never an avatar', () => {
    expect(purposeAllowsType(UPLOAD_PURPOSES.message_attachment, 'image/gif')).toBe(true);
    expect(purposeAllowsType(UPLOAD_PURPOSES.avatar, 'image/gif')).toBe(false);
  });

  it('an unlisted type belongs to no purpose', () => {
    for (const name of UPLOAD_PURPOSE_NAMES) {
      expect(purposeAllowsType(UPLOAD_PURPOSES[name], 'image/svg+xml')).toBe(false);
      expect(purposeAllowsType(UPLOAD_PURPOSES[name], 'application/x-msdownload')).toBe(false);
    }
  });
});
