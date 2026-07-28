import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  UPLOAD_PURPOSES,
  UPLOAD_PURPOSE_NAMES,
  purposeAllowsType,
  purposeOf,
  shouldProduceDerivative,
} from './purposes';

/**
 * T053 (feature 016, US3) — **adding a purpose is adding a ROW, not a code path** (FR-003 / SC-009).
 *
 * The avatar exists here as the second purpose precisely to prove that claim. ADR 0035 fixed its
 * limits and then said the avatar WAITS for this feature rather than shipping its own upload; the
 * only way that promise means anything is if its limits are enforced by the same code as the
 * attachment's, with nothing anywhere that names it.
 *
 * The second describe block is the load-bearing one. "No validation branches on a purpose name" is
 * the kind of statement that is true when written and quietly false two features later — so it is a
 * scan, not a style preference.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('the avatar’s limits are enforced by the SHARED path', () => {
  const avatar = purposeOf('avatar')!;
  const attachment = purposeOf('message_attachment')!;

  it('the same function gives different answers for the two purposes', () => {
    // One code path, two catalogue rows. If a purpose-specific branch existed, this would still
    // pass — which is why the scan below exists as well.
    expect(purposeAllowsType(attachment, 'application/pdf')).toBe(true);
    expect(purposeAllowsType(avatar, 'application/pdf')).toBe(false);

    expect(purposeAllowsType(attachment, 'image/gif')).toBe(true);
    expect(purposeAllowsType(avatar, 'image/gif')).toBe(false);

    expect(avatar.maxBytes).toBeLessThan(attachment.maxBytes);
  });

  it('ADR 0035’s numbers are the ones in the catalogue, verbatim', () => {
    expect(avatar.maxBytes).toBe(2 * 1024 * 1024);
    expect([...avatar.types].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('the avatar produces a derivative through the same rule as any image', () => {
    // ADR 0035 open item 3 (thumbnails), closed by this feature's Q3 — and closed by a catalogue
    // field rather than by an avatar-shaped special case.
    expect(shouldProduceDerivative(avatar, 'image/png')).toBe(true);
    expect(shouldProduceDerivative(attachment, 'image/png')).toBe(true);
    expect(shouldProduceDerivative(attachment, 'application/pdf')).toBe(false);
  });

  it('a hypothetical third purpose needs no new code to be enforced', () => {
    // Constructed here rather than registered: the point is that the enforcement functions accept
    // any well-formed row, so a future consumer adds data and nothing else.
    const hypothetical = {
      permission: 'reports.export',
      // Feature 017 added two facts to the row. A hypothetical future INGESTED purpose carries them
      // like any other: bytes supplied by someone else, and never deletable.
      origin: 'ingested' as const,
      ephemeral: false,
      ttlSeconds: 0,
      maxBytes: 512 * 1024,
      types: ['application/pdf'] as const,
      derivative: 'never' as const,
      derivativeLongestEdge: 256,
    };
    expect(purposeAllowsType(hypothetical, 'application/pdf')).toBe(true);
    expect(purposeAllowsType(hypothetical, 'image/png')).toBe(false);
    expect(shouldProduceDerivative(hypothetical, 'application/pdf')).toBe(false);
  });
});

describe('*** no source file in the validation path names a purpose *** (SC-009)', () => {
  /**
   * Everything a purpose flows through. The catalogue itself is excluded for the obvious reason: it
   * is where the names are supposed to live.
   */
  const VALIDATION_PATH = [
    'libs/common/src/uploads/content-type.ts',
    'libs/common/src/uploads/filename.ts',
    'services/users/src/uploads/validate.ts',
    'services/users/src/uploads/image.ts',
    'services/users/src/uploads/uploads.repository.ts',
    'services/users/src/uploads/uploads.grpc.controller.ts',
    'services/users/src/uploads/actor.ts',
    'services/users/src/uploads/object-store.ts',
    'services/gateway/src/uploads/uploads.controller.ts',
    'services/gateway/src/uploads/upload-parse.interceptor.ts',
    'services/gateway/src/uploads/serve.ts',
    'services/gateway/src/security/permission.guard.ts',
  ];

  it('the listed files all exist (the scan is not silently empty)', () => {
    for (const f of VALIDATION_PATH) {
      expect({ f, exists: statSync(join(ROOT, ...f.split('/'))).isFile() }).toEqual({
        f,
        exists: true,
      });
    }
  });

  it.each(VALIDATION_PATH)('%s contains no purpose-name literal', (file) => {
    const src = readFileSync(join(ROOT, ...file.split('/')), 'utf8');
    // Comments legitimately discuss the avatar and attachments; a BRANCH on the name is the defect.
    // So the scan looks at code lines only, with comment lines stripped.
    const code = src
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    for (const name of UPLOAD_PURPOSE_NAMES) {
      expect({ file, name, found: code.includes(`'${name}'`) || code.includes(`"${name}"`) }).toEqual(
        { file, name, found: false },
      );
    }
  });

  it('nor does any other non-catalogue file under the uploads folders', () => {
    // A belt-and-braces sweep, so a NEW file in the validation path is covered without anyone
    // remembering to add it to the list above.
    const dirs = [
      'services/users/src/uploads',
      'services/gateway/src/uploads',
      'libs/common/src/uploads',
    ];
    const allowed = new Set(['libs/common/src/uploads/purposes.ts']);
    const offenders: string[] = [];

    for (const dir of dirs) {
      for (const file of walk(join(ROOT, ...dir.split('/')))) {
        const relative = file.slice(ROOT.length + 1).split(sep).join('/');
        if (relative.endsWith('.spec.ts') || allowed.has(relative)) continue;
        const code = readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((line) => {
            const t = line.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .join('\n');
        for (const name of UPLOAD_PURPOSE_NAMES) {
          if (code.includes(`'${name}'`) || code.includes(`"${name}"`)) {
            offenders.push(`${relative} → ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the catalogue is the only place a purpose is named', () => {
  it('every registered purpose resolves and carries a complete row', () => {
    for (const name of UPLOAD_PURPOSE_NAMES) {
      const p = UPLOAD_PURPOSES[name];
      expect(p.maxBytes).toBeGreaterThan(0);
      expect(['never', 'images-only', 'always']).toContain(p.derivative);
      expect(['ingested', 'produced']).toContain(p.origin);
      // The type list is origin-dependent from feature 017 onward — an `ingested` purpose must name
      // types, a `produced` one must name none. See `purposes.spec.ts` for that assertion; here the
      // row only has to be complete.
      expect(Array.isArray(p.types)).toBe(true);
    }
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}
