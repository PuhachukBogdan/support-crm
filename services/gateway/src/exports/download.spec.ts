import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import type { Response } from 'express';
import { ExportsController } from './exports.controller';

/**
 * T046 (feature 017, US3) — **the download is authorized EVERY time, against current authority**
 * (FR-010 / SEC-21 / SEC-27).
 *
 * SEC-27 was *"contact export = a non-expiring link"*, and the property that replaces it is not "the link
 * expires" but "there is no link": every fetch is a fresh decision made with the caller's permissions as
 * they are **now**. This test is the observable form of that — the same request, twice, with the
 * permission removed in between, and nothing about the stored export changed.
 *
 * ── Two hops, and the second one is the guarantee ────────────────────────────────────────────────
 * `chats` checks ownership, readiness and expiry; `users` re-authorizes the read against the purpose's
 * permission using the metadata this controller forwards. So the assertions below are about the WIRE as
 * much as the outcome: feature 016's Track-B defect was two tiers both correct and an empty
 * `x-actor-permissions` between them, which produced a 403 on a file the caller owned.
 */
const CLAIMS = { accountId: 'acc-1', userId: 'user-1', roles: ['teamlead'], brands: [] };
const SCOPE_KEY = 'crm.exports.conversations';

const CSV = Buffer.from('id,status\r\nconv-1,open\r\n', 'utf8');

interface Recorded {
  resolveMeta: unknown;
  readMeta: unknown;
  readArgs: Record<string, unknown>;
}

/**
 * A controller wired to fakes that behave like the real services on the one axis under test: `users`
 * refuses the read unless the forwarded permission set contains the export purpose's key.
 */
function harness(opts: { permissions: string[]; usersRefuses?: boolean }) {
  const recorded: Recorded = { resolveMeta: null, readMeta: null, readArgs: {} };

  const exportsSvc = {
    createExport: jest.fn(() => of({ id: 'exp-1' })),
    listExports: jest.fn(() => of({ exports: [] })),
    getExport: jest.fn(() => of({ id: 'exp-1', status: 'ready' })),
    resolveExportArtefact: jest.fn((_d: unknown, md: unknown) => {
      recorded.resolveMeta = md;
      return of({ uploadId: 'up-1', displayName: 'conversations-2026-07-28.csv' });
    }),
  };

  const uploadsSvc = {
    readUpload: jest.fn((d: Record<string, unknown>, md: unknown) => {
      recorded.readArgs = d;
      recorded.readMeta = md;
      const forwarded = String(
        (md as { get(k: string): unknown[] }).get('x-actor-permissions')[0] ?? '',
      )
        .split(',')
        .filter(Boolean);
      // This IS what `users` does: it resolves the purpose from the stored row and checks the purpose's
      // permission against the forwarded set. No forwarded key ⇒ refusal, however legitimate the caller.
      if (opts.usersRefuses || !forwarded.includes(SCOPE_KEY)) {
        return throwError(() => ({ code: 7, message: 'forbidden' }));
      }
      return of({
        contentType: 'text/csv',
        displayName: 'conversations-2026-07-28.csv',
        inlineSafe: false,
        content: CSV,
      });
    }),
  };

  const ctl = new ExportsController(
    { getService: () => exportsSvc } as never,
    { getService: () => uploadsSvc } as never,
  );
  ctl.onModuleInit();

  const req = {
    claims: CLAIMS,
    effective: { permissionKeys: opts.permissions },
  } as never;

  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const res = {
    setHeader: (k: string, v: string) => {
      sent.headers[k.toLowerCase()] = String(v);
    },
    status: (c: number) => {
      sent.status = c;
      return res;
    },
    send: (b: unknown) => {
      sent.body = b;
      return res;
    },
    // `sendUpload` writes the body with `end(buffer)`, not `send(...)` — one place for the whole
    // response so a new route cannot serve a file with weaker headers by forgetting one.
    end: (b?: unknown) => {
      if (b !== undefined) sent.body = b;
      return res;
    },
  } as unknown as Response;

  return { ctl, req, res, sent, recorded, exportsSvc, uploadsSvc };
}

describe('*** the SAME download flips on the CALLER’s current permissions ***', () => {
  it('with the key: 200 and the bytes', async () => {
    const h = harness({ permissions: [SCOPE_KEY, 'crm.inbox.view'] });
    await h.ctl.download('exp-1', h.req, h.res);

    expect(h.sent.body).toEqual(CSV);
    expect(h.sent.headers['content-type']).toContain('text/csv');
  });

  it('*** without the key: 403, and NOTHING about the export changed ***', async () => {
    const h = harness({ permissions: ['crm.inbox.view'] });

    await expect(h.ctl.download('exp-1', h.req, h.res)).rejects.toBeInstanceOf(ForbiddenException);
    // No write of any kind on the refusal path: the record is not touched, the artefact is not deleted,
    // and the export is still valid for whoever legitimately holds the key. A revocation is not a
    // deletion — that distinction is what makes "authorize at fetch time" different from "invalidate".
    expect(h.exportsSvc.createExport).not.toHaveBeenCalled();
    expect(h.sent.body).toBeUndefined();
  });

  it('restoring the key restores the download — no re-export needed', async () => {
    // The 011 copy-on-write path, exactly as 012 and 016 exercised it live. If a revocation had
    // invalidated the artefact, the caller would have to re-export — spending quota and putting a second
    // copy of the same PII in storage.
    const revoked = harness({ permissions: [] });
    await expect(revoked.ctl.download('exp-1', revoked.req, revoked.res)).rejects.toThrow();

    const restored = harness({ permissions: [SCOPE_KEY] });
    await restored.ctl.download('exp-1', restored.req, restored.res);
    expect(restored.sent.body).toEqual(CSV);
  });

  it('an EMPTY permission set is refused, not treated as unrestricted', async () => {
    // Fail-closed on the exact shape of 016's live defect: a route with no permission metadata makes the
    // guard leave `req.effective` unset, and the forwarded value is `''`.
    const h = harness({ permissions: [] });
    await expect(h.ctl.download('exp-1', h.req, h.res)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('*** the wire carries the caller’s CURRENT permissions to BOTH hops ***', () => {
  it('both calls receive the identity and the permission set', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    await h.ctl.download('exp-1', h.req, h.res);

    for (const md of [h.recorded.resolveMeta, h.recorded.readMeta]) {
      const m = md as { get(k: string): unknown[] };
      expect(m.get('x-actor-account-id')[0]).toBe('acc-1');
      expect(m.get('x-actor-user-id')[0]).toBe('user-1');
      expect(m.get('x-actor-permissions')[0]).toBe(SCOPE_KEY);
    }
  });

  it('the read is for the ORIGINAL variant, by id — never a URL', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    await h.ctl.download('exp-1', h.req, h.res);

    expect(h.recorded.readArgs).toEqual({
      uploadId: 'up-1',
      variant: 'UPLOAD_VARIANT_ORIGINAL',
    });
  });

  it('a refusal from chats short-circuits — users is never asked', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    h.exportsSvc.resolveExportArtefact = jest.fn(() => throwError(() => ({ code: 5 }))) as never;
    const ctl = new ExportsController(
      { getService: () => h.exportsSvc } as never,
      { getService: () => h.uploadsSvc } as never,
    );
    ctl.onModuleInit();

    await expect(ctl.download('exp-1', h.req, h.res)).rejects.toBeInstanceOf(NotFoundException);
    // An expired or non-owned export must not reach storage at all: asking would be a request for bytes
    // the caller has just been told do not exist.
    expect(h.uploadsSvc.readUpload).not.toHaveBeenCalled();
  });
});

describe('*** the response posture is the hardened one, always *** (FR-023)', () => {
  it('attachment, nosniff, and no-store', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    await h.ctl.download('exp-1', h.req, h.res);

    expect(h.sent.headers['content-disposition']).toContain('attachment');
    expect(h.sent.headers['x-content-type-options']).toBe('nosniff');
    // A bulk PII payload must not sit in a disk cache outliving both the expiry and the purge — which
    // would quietly defeat FR-013 from the client side.
    expect(h.sent.headers['cache-control']).toContain('no-store');
    expect(h.sent.headers['cache-control']).toContain('private');
  });

  it('a CSV is never served inline, whatever the upload row says', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    await h.ctl.download('exp-1', h.req, h.res);
    expect(h.sent.headers['content-disposition']).not.toContain('inline');
  });

  it('the filename comes from chats (scope + date), not from anything a user typed', async () => {
    const h = harness({ permissions: [SCOPE_KEY] });
    await h.ctl.download('exp-1', h.req, h.res);
    // A filename travels with the file and is echoed by browsers and mail clients, so a filter term
    // inside it would be a PII leak with a very long tail (SEC-26).
    expect(h.sent.headers['content-disposition']).toContain('conversations-2026-07-28.csv');
  });
});
