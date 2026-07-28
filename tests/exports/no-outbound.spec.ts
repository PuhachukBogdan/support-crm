import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  UPLOAD_CHANNEL_BYTES,
  UPLOAD_CLIENT_CHANNEL_OPTIONS,
} from '../../libs/common/src/grpc';
import { EXPORT_SCOPES } from '../../libs/common/src/exports/scopes';

/**
 * T056a / T057 (feature 017, polish) — **this feature introduces NO outbound destination** (FR-024,
 * Principle III), and the one internal hop that carries a file is covered by the raised channel limit.
 *
 * ── Why FR-024 needs a test at all ──────────────────────────────────────────────────────────────
 * `/speckit-analyze` flagged it as the requirement with zero coverage, and the reason it matters is
 * SEC-C5: the previous system let a transcript be **emailed to any address**. "Export and send it to me"
 * is the single most natural next request for this feature, and the moment it exists the download's whole
 * authorization model is bypassed — the artefact leaves through a channel that authorizes nothing and
 * expires never. The delivery mechanism being absent is the guarantee; so absence is what is asserted.
 *
 * The only external edge in the entire feature is the object store, reached by `users` alone, and
 * `external-data-flows.md` therefore needs no new row beyond the storage row feature 016 already recorded.
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

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const productSources = SERVICES.flatMap((s) => walk(join(ROOT, 'services', s, 'src')))
  .concat(walk(join(ROOT, 'libs', 'common', 'src')))
  .filter((f) => !f.endsWith('.spec.ts'));

/** Every file this feature added or touched on the export path. */
const exportSources = productSources.filter(
  (f) => /\/exports?\//.test(rel(f)) || /export-run\.job|expiry-sweep\.job|artefact-purge/.test(rel(f)),
);

describe('the scan sees the feature (guards against a vacuous pass)', () => {
  it('covers the edge, the producer, the purge and both worker ticks', () => {
    const paths = exportSources.map(rel);
    expect(paths).toContain('services/gateway/src/exports/exports.controller.ts');
    expect(paths).toContain('services/chats/src/export/export.producer.ts');
    expect(paths).toContain('services/users/src/uploads/artefact-purge.repository.ts');
    expect(paths).toContain('services/worker/src/jobs/export-run.job.ts');
    expect(paths).toContain('services/worker/src/jobs/expiry-sweep.job.ts');
  });
});

describe('*** no export path can send an artefact anywhere *** (FR-024 / SEC-C5)', () => {
  const DELIVERY = [
    'nodemailer',
    'sendmail',
    'smtp',
    '@sendgrid',
    'mailgun',
    'postmark',
    // The SES client specifically — a bare 'ses' matched `purposes` and `responses`, and a scan that
    // fires on ordinary words is a scan somebody deletes.
    '@aws-sdk/client-ses',
    'webhook',
    'axios',
    'node-fetch',
    'got',
    'undici',
    'superagent',
    'http.request',
    'https.request',
    'WebSocket',
    'telegram',
    'slack',
  ];

  it.each(DELIVERY)('nothing on the export path reaches for %s', (marker) => {
    const offenders = exportSources
      .filter((f) => codeOf(f).toLowerCase().includes(marker.toLowerCase()))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no bare fetch() call either', () => {
    // `fetch` is global in Node 22, so an outbound call needs no import at all — which makes the import
    // scan above insufficient on its own.
    const offenders = exportSources
      .filter((f) => /\bfetch\s*\(/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no export path reads a destination from configuration', () => {
    // A destination arriving as config is the same feature with an extra step, and it would ship
    // "disabled by default" — which is how it gets enabled in an incident.
    const offenders = exportSources
      .filter((f) => /process\.env\.[A-Z_]*(MAIL|SMTP|WEBHOOK|NOTIFY|RECIPIENT|CALLBACK)/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the scope catalogue has no delivery field — a destination is not configurable as data', () => {
    // The catalogue is where a `deliverTo` would naturally be added, precisely because everything else in
    // this feature is data. Its absence is a decision.
    const fields = Object.keys(EXPORT_SCOPES.conversations).sort();
    expect(fields).toEqual([
      'format',
      'maxBytes',
      'mayContainContactData',
      'permission',
      'quotaMax',
      'quotaWindowSeconds',
      'rowLimit',
      'ttlSeconds',
    ]);
  });
});

describe('*** the only external edge is the object store, reached by users alone ***', () => {
  it('no export path outside users/src/uploads touches the store', () => {
    const offenders = exportSources
      .filter((f) => !rel(f).startsWith('services/users/src/uploads'))
      .filter((f) => /@aws-sdk|S3Client|process\.env\.S3_/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the worker — the only always-running component — never touches storage or a network peer', () => {
    // It schedules. It owns no database, holds no credentials, and its two clients are gRPC to our own
    // services. That is what keeps "the heavy work is dispatched" from meaning "the worker gained reach".
    for (const job of ['export-run.job.ts', 'expiry-sweep.job.ts']) {
      const code = codeOf(join(ROOT, 'services', 'worker', 'src', 'jobs', job));
      expect(code).not.toMatch(/@aws-sdk|fetch\(|axios|http[s]?\.request/);
    }
  });
});

describe('*** the artefact hop is covered by the RAISED 12 MB limit *** (T057 / research open item 3)', () => {
  const uploadsClient = codeOf(
    join(ROOT, 'services', 'chats', 'src', 'uploads', 'uploads.client.ts'),
  );

  it('the chats→users client passes the upload channel options', () => {
    // Without this the client defaults to 4 MB while the SERVER accepts 12, so an export between 4 and 10
    // MB fails on the client side — invisible to every Track A test, because a fake client has no
    // channel. This assertion is the Track A half; scenario G17 is the live confirmation.
    expect(uploadsClient).toContain('UPLOAD_CLIENT_CHANNEL_OPTIONS');
  });

  it('the scope’s byte cap sits INSIDE the channel, with headroom', () => {
    // 10 MB against a 12 MB channel: the artefact plus its metadata must fit, so a scope cannot be
    // configured into a transport failure. If someone raises `maxBytes` past the channel, this fails.
    expect(EXPORT_SCOPES.conversations.maxBytes).toBeLessThan(UPLOAD_CHANNEL_BYTES);
    expect(UPLOAD_CHANNEL_BYTES - EXPORT_SCOPES.conversations.maxBytes).toBeGreaterThanOrEqual(
      1024 * 1024,
    );
  });

  it('the channel options raise BOTH directions', () => {
    // Send only would be enough for the upload and wrong for the response; a half-raised channel is the
    // kind of thing that works in testing and fails on the largest real file.
    expect(UPLOAD_CLIENT_CHANNEL_OPTIONS['grpc.max_send_message_length']).toBe(UPLOAD_CHANNEL_BYTES);
    expect(UPLOAD_CLIENT_CHANNEL_OPTIONS['grpc.max_receive_message_length']).toBe(
      UPLOAD_CHANNEL_BYTES,
    );
  });
});
