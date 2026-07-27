import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * T059 (feature 016) — **no filename and no file content reaches a log or an error payload**
 * (SC-007 / FR-020 / Principle IV / SEC-26), on the FAILURE paths as well as the happy one.
 *
 * ── Why filenames specifically ───────────────────────────────────────────────────────────────────
 * A filename can itself be PII: `john_smith_passport.jpg` names a person and a document type before
 * anyone opens it. And it is the easiest thing in this feature to leak by accident — upload
 * middleware logs filenames BY DEFAULT, and every error object multer produces carries one. That is
 * the trap this file exists for.
 *
 * ── Why a scan and not only behaviour ────────────────────────────────────────────────────────────
 * A behavioural test can only cover the paths it thinks to exercise, and the dangerous case is the
 * one nobody thought of — a `catch` added next year that logs `err` wholesale. So the runtime
 * assertions below are paired with a structural scan of every file on the upload path.
 */
const ROOT = resolve(__dirname, '..', '..');

const UPLOAD_DIRS = [
  'services/users/src/uploads',
  'services/gateway/src/uploads',
  'libs/common/src/uploads',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

/** Code with comments stripped — the scans police behaviour, not prose (as in the ingest scan). */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const uploadSources = UPLOAD_DIRS.flatMap((d) => walk(join(ROOT, ...d.split('/'))));

describe('the scan sees the upload path (guards against a vacuous pass)', () => {
  it('covers all three folders', () => {
    expect(uploadSources.length).toBeGreaterThan(8);
    for (const dir of UPLOAD_DIRS) {
      expect(uploadSources.some((f) => rel(f).startsWith(dir))).toBe(true);
    }
  });
});

describe('*** nothing on the upload path logs a filename ***', () => {
  it('no log call mentions a filename-bearing identifier', () => {
    // `originalname` is multer's field and `filename`/`displayName` are ours. If any of them appears
    // inside a log call, the value ends up in a log line.
    const offenders: string[] = [];
    const LOG = /(logInfo|logger\.\w+|console\.(log|warn|error|info|debug))\s*\(/g;
    for (const file of uploadSources) {
      const code = codeOf(file);
      for (const m of code.matchAll(LOG)) {
        // Take the call's argument text up to the end of the statement.
        const tail = code.slice(m.index ?? 0, (m.index ?? 0) + 400);
        const call = tail.slice(0, tail.indexOf(');') + 1);
        if (/originalname|displayName|display_name|filename|\bfileName\b/.test(call)) {
          offenders.push(`${rel(file)} → ${call.split('\n')[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no log call passes a raw error or a whole request/file object', () => {
    // `logInfo('users', 'failed', { err })` is the shape that leaks: a multer error carries the
    // original filename, and an SDK error can carry a response body.
    const offenders: string[] = [];
    const LOG = /(logInfo|logger\.\w+|console\.(log|warn|error|info|debug))\s*\(/g;
    for (const file of uploadSources) {
      const code = codeOf(file);
      for (const m of code.matchAll(LOG)) {
        const tail = code.slice(m.index ?? 0, (m.index ?? 0) + 400);
        const call = tail.slice(0, tail.indexOf(');') + 1);
        if (/\b(err|error|e)\b\s*[,}]|\{\s*(err|error)\s*\}|\breq\b\s*[,}]|\bfile\b\s*[,}]/.test(call)) {
          offenders.push(`${rel(file)} → ${call.split('\n')[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing logs file content, a buffer or a base64 body', () => {
    const offenders: string[] = [];
    for (const file of uploadSources) {
      const code = codeOf(file);
      if (/(logInfo|console\.\w+)[^;]*\b(buffer|content|bytes|body)\b/.test(code)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('*** refusals carry a reason CODE, not the input *** (the failure paths)', () => {
  it('the validation error type holds a closed reason and nothing else', () => {
    const code = codeOf(join(ROOT, 'services', 'users', 'src', 'uploads', 'validate.ts'));
    // `UploadRejected` takes exactly one constructor parameter, and it is the reason.
    expect(/class UploadRejected extends Error \{\s*constructor\(readonly reason: UploadRejectionReason\)/.test(code)).toBe(true);
    // …and the message is built from the reason alone.
    expect(code).toContain('`upload refused: ${reason}`');
  });

  it('the image error type does the same', () => {
    const code = codeOf(join(ROOT, 'services', 'users', 'src', 'uploads', 'image.ts'));
    expect(/class ImageRejected extends Error \{\s*constructor\(readonly reason: ImageRejectionReason\)/.test(code)).toBe(true);
    // The decoder's own error is deliberately NOT attached: a libvips message can echo file content.
    expect(code).not.toMatch(/throw new ImageRejected\([^)]*err/);
  });

  it('the object-store error carries an operation and an error NAME, never a key or a body', () => {
    const code = codeOf(join(ROOT, 'services', 'users', 'src', 'uploads', 'object-store.ts'));
    expect(code).toContain("cause instanceof Error ? cause.name : 'unknown'");
    // If the key were interpolated into the message it would travel with every thrown error.
    expect(code).not.toMatch(/object store \$\{[^}]*key/);
  });

  it('the multipart failure path maps a CODE and forwards nothing from the error', () => {
    const code = codeOf(
      join(ROOT, 'services', 'gateway', 'src', 'uploads', 'upload-parse.interceptor.ts'),
    );
    // multer's error carries `field` and can carry the original filename; only `code` is consulted.
    expect(code).toContain("const code = (err as { code?: string })?.code;");
    expect(code).not.toMatch(/new (BadRequestException|HttpException)\([^)]*err\b/);
  });

  it('the gRPC→HTTP mapping is message-free, so no downstream detail escapes', () => {
    const code = codeOf(join(ROOT, 'services', 'gateway', 'src', 'uploads', 'rpc.ts'));
    // Every branch returns a fixed string. A `err.details` passthrough would surface whatever the
    // service put there — which on a validation failure could be a filename.
    expect(code).not.toContain('err.details');
    expect(code).not.toContain('err.message');
  });
});

describe('*** the discrepancy log names storage KEYS, which are system-generated ***', () => {
  it('the failed-write path logs keys and nothing from the client', () => {
    const code = codeOf(join(ROOT, 'services', 'users', 'src', 'uploads', 'uploads.repository.ts'));
    // Without the key an operator cannot find the orphaned object; with a filename it would be a PII
    // leak in the one place PII is hardest to redact later. `{account}/{purpose}/{uuid}` is neither.
    expect(code).toContain("logInfo('users', 'upload.record_write_failed', { storageKeys: orphans })");
    expect(code).not.toMatch(/logInfo\([^)]*display_name/);
  });

  it('the claim log records a COUNT, not the ids', () => {
    const code = codeOf(join(ROOT, 'services', 'users', 'src', 'uploads', 'uploads.repository.ts'));
    expect(code).toContain('count: ids.length');
    expect(code).not.toMatch(/logInfo\([^)]*\bids\b\s*[,}]/);
  });
});
