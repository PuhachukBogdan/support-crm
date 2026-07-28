import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * T047 (feature 017, US3) — **nothing in this feature issues a link** (FR-010 / SC-007).
 *
 * SEC-27's actual content was *"contact export today = a non-expiring link"*. A presigned URL is that
 * defect with better ergonomics: it moves the authorization decision to link-CREATION time, so whoever
 * holds the string has access for the length of the window regardless of who they are, what they may read
 * now, or whether the export has since expired. It also travels — into chat, into email, into a ticket.
 *
 * The reason this is a structural scan rather than a behavioural test: a presign is the obvious
 * performance shortcut for the next person who finds the brokered download slow. Nothing about the
 * feature's behaviour today would change if it were added — the guarantee is the ABSENCE of the code, so
 * absence is what is asserted. Modelled on 016's own scan and 015's append-only scan for the same reason.
 */
const ROOT = resolve(__dirname, '..', '..');
const SERVICES = ['auth', 'users', 'brands', 'chats', 'gateway', 'worker'] as const;

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

/** Comments stripped — this codebase documents at length WHY it does not presign (016's precedent). */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const productSources = SERVICES.flatMap((s) => walk(join(ROOT, 'services', s, 'src')))
  .concat(walk(join(ROOT, 'libs', 'common', 'src')))
  .filter((f) => !f.endsWith('.spec.ts'));

const exportSources = productSources.filter((f) => /\/exports?\//.test(rel(f)));

describe('the scan is not vacuous', () => {
  it('sees the export code in both the gateway and chats', () => {
    const paths = exportSources.map(rel);
    expect(paths).toContain('services/gateway/src/exports/exports.controller.ts');
    expect(paths).toContain('services/chats/src/export/export.service.ts');
    expect(exportSources.length).toBeGreaterThan(5);
  });
});

describe('*** no export path constructs a signing or presigning primitive ***', () => {
  const SIGNING = [
    'getSignedUrl',
    's3-request-presigner',
    'createPresigned',
    'presign',
    'X-Amz-Signature',
    'X-Amz-Credential',
  ];

  it.each(SIGNING)('nothing in the export code mentions %s', (marker) => {
    const offenders = exportSources
      .filter((f) => codeOf(f).toLowerCase().includes(marker.toLowerCase()))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('nor anywhere else in the product (016’s guarantee, re-asserted from this feature’s side)', () => {
    const offenders = productSources
      .filter((f) => /getSignedUrl|s3-request-presigner|createPresigned/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no export path builds a URL to the object store at all', () => {
    // Not just SIGNED links: a bare bucket URL handed to a client would be either useless (private
    // bucket) or a public-bucket leak. Either way the download must go through the broker.
    const offenders = exportSources
      .filter((f) => /S3_ENDPOINT|\.amazonaws\.com|minio:9000/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('*** the artefact reference is an ID, not a URL ***', () => {
  /**
   * The proto with its comments removed — and this one is not theoretical caution.
   *
   * The first version of this test failed on the contract's OWN documentation: the `upload_id` field is
   * annotated *"never a URL, never signed"*, which a raw text match reads as a mention of a URL. The
   * repair a developer reaches for in that moment is deleting the annotation, which is the exact wrong
   * outcome — the prose is why the next reader understands the field. Same lesson as 016's scan, met again
   * from a different direction.
   */
  const chatsProto = readFileSync(
    join(ROOT, 'libs', 'proto', 'crm', 'chats', 'v1', 'chats.proto'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('ResolveExportArtefact returns an upload id and a display name — no url field', () => {
    const message = /message\s+ExportArtefactRef\s*\{([\s\S]*?)\n\}/.exec(chatsProto)?.[1] ?? '';
    expect(message).toMatch(/upload_id\s*=\s*\d+;/);
    // The contract is where a future `url` field would be added first, so the contract is where it is
    // refused. A field named for a link is the shape of the defect, whatever the code does with it.
    expect(message).not.toMatch(/\burl\b|\blink\b|\btoken\b|\bexpires_in\b/i);
  });

  it('the response carries no expiry of its own — there is no window to leak', () => {
    // A presigned URL needs a validity window. Its absence from the contract is the observable form of
    // "authorization happens at fetch time" (FR-010).
    const message = /message\s+ExportArtefactRef\s*\{([\s\S]*?)\n\}/.exec(chatsProto)?.[1] ?? '';
    expect(message).not.toMatch(/valid_until|expires_at|signature/i);
  });
});

describe('*** no gateway route reaches a maintenance RPC ***', () => {
  const gatewaySources = walk(join(ROOT, 'services', 'gateway', 'src')).filter(
    (f) => !f.endsWith('.spec.ts'),
  );

  it.each(['RunDueExports', 'ExpireDueExports', 'PurgeExpiredArtefacts'])(
    '%s is unreachable from the HTTP edge',
    (rpc) => {
      // These are system-actor-only by a metadata check. That check is worthless if HTTP can ask — and
      // `PurgeExpiredArtefacts` is the one path in the product that destroys bytes.
      const offenders = gatewaySources
        .filter((f) => codeOf(f).includes(rpc))
        .map(rel);
      expect(offenders).toEqual([]);
    },
  );

  it('the gateway names neither maintenance service', () => {
    const offenders = gatewaySources
      .filter((f) => /ChatsMaintenanceService|UsersMaintenanceService/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
