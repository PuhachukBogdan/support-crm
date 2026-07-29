import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { parseExportFilters } from './wire';

/**
 * T055 (feature 017, polish) — the EDGE's half of "no PII in logs" (SEC-26 / Principle IV).
 *
 * The gateway's exposure is different from the service's and in one way worse: it is the only place that
 * sees the caller's raw request body, so it is the only place a filter value exists before it has been
 * validated. It is also where a 400 message is written — and an error message is a log line and a client
 * response at the same time.
 *
 * Two kinds of assertion, because neither alone is enough: behavioural ones on the refusal path (the
 * message a caller actually receives), and a structural scan of the whole folder for the shapes that leak
 * by accident — `logger.warn(err)`, `console.log(req.body)`, a filename in a log call.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const EXPORTS_DIR = join(ROOT, 'services', 'gateway', 'src', 'exports');

/**
 * Derived from the folder, not hand-listed (fixed 2026-07-29). The list used to be the literal
 * three files that existed the day it was written, so a NEW file in this folder inherited the
 * guarantee in prose and nothing in the test — the guard would have stayed green while the leak
 * it exists to prevent walked in beside it. The floor below keeps the derivation itself honest:
 * a rename that empties the scan must fail loudly rather than pass on nothing.
 */
const FILES = readdirSync(EXPORTS_DIR).filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'));

function codeOf(name: string): string {
  return readFileSync(join(EXPORTS_DIR, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

describe('*** a refusal names the KEY and never echoes the VALUE ***', () => {
  it.each([
    ['an unknown filter key', { brnad: 'brand-secret-casino' }],
    ['a reserved key', { accountId: 'acc-other' }],
    ['a non-string value', { playerId: 4711 }],
  ])('%s: the message carries the key, not the value', (_label, body) => {
    let message = '';
    try {
      parseExportFilters(body);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      message = (err as BadRequestException).message;
    }
    expect(message).not.toContain('brand-secret-casino');
    expect(message).not.toContain('acc-other');
    expect(message).not.toContain('4711');
  });

  it('an unknown ENUM member is refused without repeating what was sent', () => {
    // The member itself is not PII — but the habit is what matters: an error that echoes input is the
    // mechanism, and it does not distinguish an enum typo from an email address.
    let message = '';
    try {
      parseExportFilters({ status: 'ply-4711@example.com' });
    } catch (err) {
      message = (err as BadRequestException).message;
    }
    expect(message).not.toContain('ply-4711');
    expect(message).not.toContain('example.com');
  });
});

describe('*** nothing in the exports folder logs at all ***', () => {
  it('the scan covers the whole folder and is not empty', () => {
    expect(FILES).toEqual(expect.arrayContaining(['exports.controller.ts', 'wire.ts']));
    expect(FILES.length).toBeGreaterThanOrEqual(3);
  });

  it('there is no logger and no console call', () => {
    // The strongest available form of this guarantee, and it costs nothing here: the edge has nothing to
    // say that the audit trail does not already record. Feature 016's live 403 was diagnosed from the
    // SERVICE logs, not the gateway's — so the absence has been tested in practice as well.
    const offenders: string[] = [];
    for (const name of FILES) {
      const code = codeOf(name);
      if (/\b(new Logger|this\.logger|console\.(log|warn|error|info|debug))\b/.test(code)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the request body is never passed anywhere whole', () => {
    const code = codeOf('exports.controller.ts');
    // `req.body` appears exactly once, as the argument to the fail-closed parser. Forwarding it to the
    // service would defeat the parse; logging it would print the filters.
    const uses = [...code.matchAll(/req\.body/g)];
    expect(uses).toHaveLength(1);
    expect(code).toContain('parseExportFilters(req.body as unknown)');
  });

  it('the display name is used for the header and nothing else', () => {
    const code = codeOf('exports.controller.ts');
    // A filename travels with the file and is echoed by browsers and mail clients. It reaches
    // `sendUpload` (which sets Content-Disposition) and no other call.
    expect(code).toMatch(/displayName:\s*ref\.displayName\s*\|\|\s*content\.displayName/);
    expect(code).not.toMatch(/(logInfo|logger|console)[^;]*displayName/);
  });

  it('no downstream error detail is forwarded to the client', () => {
    const code = codeOf('exports.controller.ts');
    // Mapping goes through 016's message-free `toHttp`. A `err.details` passthrough would surface
    // whatever the service put there — on a validation failure, potentially a filter value.
    expect(code).not.toContain('err.details');
    expect(code).not.toContain('err.message');
    expect(code).toContain('callUploads(');
  });
});
