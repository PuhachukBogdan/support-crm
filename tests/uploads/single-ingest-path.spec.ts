import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AUDIT_ACTIONS } from '../../libs/common/src/audit/catalogue';

/**
 * T052 (feature 016, US3) — **there is exactly ONE way for bytes to enter or leave this product.**
 * SC-001 / FR-001 / research R9.
 *
 * This is the test the whole feature exists for, and it is a structural scan rather than a
 * behavioural one for a specific reason. SEC-1 was not "an upload endpoint had a broken auth check":
 * it was "there were TWO upload endpoints, and the second one's own check passed for an anonymous
 * request". Hardening one path leaves that class of defect completely intact, because the next
 * feature that needs to accept a file writes a third path with its own validation, its own limits
 * and its own idea of who may read the result.
 *
 * So: "we only built one" is a promise about today. "No second one exists" is a promise about the
 * product. Only the second kind can be tested, and this is that test. Modelled on feature 015's
 * append-only scan for the same reason.
 */
const ROOT = resolve(__dirname, '..', '..');
const SERVICES = ['auth', 'users', 'brands', 'chats', 'gateway', 'worker'] as const;

/** The one folder allowed to touch bytes and storage credentials. */
const UPLOADS_HOME = 'services/users/src/uploads';
/** The one folder in the gateway allowed to parse multipart. */
const GATEWAY_UPLOADS = 'services/gateway/src/uploads';

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

/**
 * A file's CODE, with comments removed.
 *
 * Every scan below matches on source text, and this codebase documents its decisions at length —
 * `object-store.ts` explains at some length that it does not call `getSignedUrl`, and the in-memory
 * fake explains that it does not import the AWS SDK. Matching raw text would fail on both, and the
 * repair a future developer reaches for is deleting the explanation, which is exactly the wrong
 * outcome: the prose is why the property is understood.
 *
 * Stripping comments costs nothing in strength — an import or a call inside a comment does not
 * execute — and it means the scan polices behaviour rather than vocabulary.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSDoc
    .replace(/^[ \t]*\/\/.*$/gm, '') // whole-line // comments
    .replace(/([^:'"`])\/\/.*$/gm, '$1'); // trailing // comments (leaves URLs in strings alone)
}

const productSources = SERVICES.flatMap((s) => walk(join(ROOT, 'services', s, 'src')))
  .concat(walk(join(ROOT, 'libs', 'common', 'src')))
  // Specs describe the code; they are not the product surface.
  .filter((f) => !f.endsWith('.spec.ts'));

describe('the scan finds what it is meant to police (guards against a vacuous pass)', () => {
  it('sees the whole product source tree, including the uploads code', () => {
    expect(productSources.length).toBeGreaterThan(100);
    expect(productSources.some((f) => rel(f).startsWith(UPLOADS_HOME))).toBe(true);
    expect(productSources.some((f) => rel(f).startsWith(GATEWAY_UPLOADS))).toBe(true);
  });
});

describe('*** 1. the gateway parses multipart in exactly one place ***', () => {
  const MULTIPART = [
    'FileInterceptor',
    'FilesInterceptor',
    'AnyFilesInterceptor',
    'FileFieldsInterceptor',
    'multipart/form-data',
    "from 'multer'",
    'require("multer")',
  ];

  it('no file/multipart handling anywhere in the gateway outside src/uploads/', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'services', 'gateway', 'src'))) {
      if (file.endsWith('.spec.ts')) continue;
      if (rel(file).startsWith(GATEWAY_UPLOADS)) continue;
      const src = codeOf(file);
      for (const marker of MULTIPART) {
        if (src.includes(marker)) offenders.push(`${rel(file)} → ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no OTHER service parses multipart at all', () => {
    // Only the gateway is an HTTP ingress. A backend service growing a file-accepting surface would
    // be a second path by definition.
    const offenders: string[] = [];
    for (const service of SERVICES.filter((s) => s !== 'gateway')) {
      for (const file of walk(join(ROOT, 'services', service, 'src'))) {
        if (file.endsWith('.spec.ts')) continue;
        const src = codeOf(file);
        for (const marker of MULTIPART) {
          if (src.includes(marker)) offenders.push(`${rel(file)} → ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('*** 2. exactly one file in the repository can reach the object store ***', () => {
  it('no @aws-sdk/client-s3 import outside services/users/src/uploads/', () => {
    // This concentration IS the SEC-1 fix. "One validated path" is only checkable if validation and
    // storage are the SAME component — the moment a second file can write to the bucket, the
    // guarantee is a convention again.
    const offenders = productSources
      .filter((f) => !rel(f).startsWith(UPLOADS_HOME))
      .filter((f) => codeOf(f).includes('@aws-sdk/client-s3'))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('…and inside that folder it is exactly one file', () => {
    const importers = walk(join(ROOT, ...UPLOADS_HOME.split('/')))
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => codeOf(f).includes('@aws-sdk/client-s3'))
      .map(rel);
    expect(importers).toEqual([`${UPLOADS_HOME}/object-store.ts`]);
  });

  it('nothing anywhere signs a URL for a client (reads are brokered — FR-010)', () => {
    // A presigned URL grants access to whoever holds it for the length of its window, which is
    // exactly the SEC-10 leaked-link case. Its ABSENCE is the guarantee.
    const offenders = productSources
      .filter((f) => /getSignedUrl|@aws-sdk\/s3-request-presigner|createPresigned/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('*** 3. no other RPC in the product carries a byte payload ***', () => {
  const protoFiles = walk(join(ROOT, 'libs', 'proto'))
    .concat(
      readdirSync(join(ROOT, 'libs', 'proto'), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.proto'))
        .map((e) =>
          resolve(
            (e as { parentPath?: string; path?: string }).parentPath ??
              (e as { path?: string }).path ??
              join(ROOT, 'libs', 'proto'),
            e.name,
          ),
        ),
    )
    .filter((f) => f.endsWith('.proto'));

  it('finds the proto tree', () => {
    expect(protoFiles.length).toBeGreaterThan(3);
  });

  it('only the uploads messages declare a `bytes` field', () => {
    // A `bytes` field is the shape of a file crossing a service boundary. Any other RPC growing one
    // is a second ingest by another name — one that would not go through validation.
    const found: string[] = [];
    for (const file of protoFiles) {
      const src = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      let currentMessage = '';
      for (const line of src.split(/\r?\n/)) {
        const msg = /^\s*message\s+(\w+)\s*\{/.exec(line);
        if (msg) currentMessage = msg[1]!;
        if (/^\s*bytes\s+\w+\s*=\s*\d+\s*;/.test(line)) {
          found.push(`${rel(file)}:${currentMessage}`);
        }
      }
    }
    expect(found.sort()).toEqual([
      'libs/proto/crm/users/v1/users.proto:CreateUploadRequest',
      'libs/proto/crm/users/v1/users.proto:UploadContent',
    ]);
  });

  it('no update, delete or presign RPC exists on the uploads surface', () => {
    // Nothing in v1 removes bytes. Reclaiming abandoned uploads is a retention concern (ADR 0015)
    // and its own feature — which must also decide what a `deletion` audit entry looks like.
    const src = readFileSync(join(ROOT, 'libs', 'proto', 'crm', 'users', 'v1', 'users.proto'), 'utf8');
    for (const forbidden of ['UpdateUpload', 'DeleteUpload', 'PresignUpload', 'SignUpload']) {
      expect(new RegExp(`rpc\\s+${forbidden}`).test(src)).toBe(false);
    }
  });
});

describe('*** 4. exactly one service holds object-store configuration ***', () => {
  it('only users declares the S3_* keys', () => {
    // The gateway gaining nothing is the OBSERVABLE form of credential containment (research R10):
    // a reviewer sees the property in the config schemas without reading a line of upload code.
    const declarers = SERVICES.filter((service) => {
      const cfg = join(ROOT, 'services', service, 'src', 'config.ts');
      try {
        return /S3_(ENDPOINT|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY)/.test(codeOf(cfg));
      } catch {
        return false;
      }
    });
    expect(declarers).toEqual(['users']);
  });

  it('no other service reads an S3_* environment variable anywhere', () => {
    const offenders = productSources
      .filter((f) => !rel(f).startsWith('services/users/src'))
      .filter((f) => /process\.env\.S3_/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('*** 5. uploads are not audited, and no action is defined either *** (spec Q2)', () => {
  it('the audit catalogue contains no upload action', () => {
    // Q2 decided this deliberately: an upload is ordinary work, like posting a message, and the
    // message already answers "who sent this to the customer". Option D — define it now, write it
    // later — was rejected because feature 015 defined `export.create` for a KNOWN planned writer,
    // and there is no planned feature that audits uploads. A catalogue entry that exists in case
    // somebody wants it is not documentation of intent; it is an invitation.
    //
    // A decision with no test protecting it is undone by the next feature that finds the catalogue
    // convenient, which is why this assertion lives here rather than in a comment.
    const uploadActions = Object.keys(AUDIT_ACTIONS).filter((a) =>
      /^(upload|file|attachment)\./.test(a),
    );
    expect(uploadActions).toEqual([]);
  });

  it('nothing in the uploads code writes an audit entry', () => {
    const offenders = walk(join(ROOT, ...UPLOADS_HOME.split('/')))
      .concat(walk(join(ROOT, ...GATEWAY_UPLOADS.split('/'))))
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => /AuditRepository|auditEntry\.|buildEntry\(/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
