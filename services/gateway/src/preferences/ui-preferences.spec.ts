import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { stripComments } from '@crm/common';
import {
  REQUIRED_PERMISSION_KEY,
  RESOLVE_PERMISSIONS_KEY,
} from '../security/requires-permission.decorator';
import { UiPreferencesEdgeController } from './ui-preferences.controller';

/**
 * The `/me/ui-preferences` edge (feature 021, roadmap 5.6).
 *
 * The first block is the one this product has now paid for three times (4.9, 5.1, 5.2): the guard
 * populates `req.effective` **only** for routes carrying permission metadata, and the metadata builder
 * reads exactly that to fill `x-is-preview`. Drop the decorator and the owning service's independent
 * preview refusal becomes unreachable — with every other test still green, because the gateway's own
 * write-block already covers the case.
 */

const CLAIMS = { accountId: 'acc-1', userId: 'user-1', roles: ['support'] };

const effective = (over: Record<string, unknown> = {}) => ({
  roleKey: 'support',
  permissionKeys: [],
  mode: 'inherited' as const,
  isPreview: false,
  readOnly: false,
  ...over,
});

function harness() {
  const recorded: { meta?: Record<string, unknown>; args?: Record<string, unknown> } = {};
  const capture = (d: Record<string, unknown>, md: unknown) => {
    recorded.args = d;
    recorded.meta = md as Record<string, unknown>;
    return of({ values: { theme_mode: 'light', font_size_step: 'default' } });
  };
  const svc = {
    getOperatorUiPreferences: jest.fn(capture),
    updateOperatorUiPreferences: jest.fn(capture),
  };
  const ctl = new UiPreferencesEdgeController({
    getService: () => svc,
  } as never);
  ctl.onModuleInit();
  return { ctl, svc, recorded };
}

const req = (over: Record<string, unknown> = {}) =>
  ({ claims: CLAIMS, effective: effective(), ...over }) as never;

/** Read a header out of the grpc Metadata the controller built. */
function header(meta: unknown, key: string): string | undefined {
  const got = (meta as { get?: (k: string) => unknown[] })?.get?.(key);
  const first = Array.isArray(got) ? got[0] : undefined;
  return typeof first === 'string' ? first : undefined;
}

describe('*** ⚠️ both routes resolve permissions, so the second tier can fire ***', () => {
  const ROUTES = ['get', 'patch'] as const;

  it.each(ROUTES)('`%s` carries @ResolvesPermissions()', (name) => {
    const fn = UiPreferencesEdgeController.prototype[name];
    expect(Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, fn)).toBe(true);
  });

  it.each(ROUTES)('`%s` requires NO permission key — nothing here is gated', (name) => {
    // ADR 0035's hard boundary. If this starts failing, a permission has been introduced into a
    // surface that may never hold one.
    const fn = UiPreferencesEdgeController.prototype[name];
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, fn)).toBeUndefined();
  });

  it('the route list is DERIVED from the controller, not typed out here', () => {
    // Feature 016's version of this test enumerated route names by hand, so a fourth route added
    // without a decorator AND without being added to the list would have passed silently.
    const handlers = Object.getOwnPropertyNames(UiPreferencesEdgeController.prototype).filter(
      (n) => n !== 'constructor' && n !== 'onModuleInit' && n !== 'meta',
    );
    expect(handlers.sort()).toEqual([...ROUTES].sort());
  });

  it('forwards `x-is-preview` when a preview is active — the header the service needs', () => {
    const h = harness();
    void h.ctl.get(req({ effective: effective({ isPreview: true }) }));
    expect(header(h.recorded.meta, 'x-is-preview')).toBe('true');
  });

  it('forwards account and person identity from the VALIDATED claims', () => {
    const h = harness();
    void h.ctl.get(req());
    expect(header(h.recorded.meta, 'x-actor-account-id')).toBe('acc-1');
    expect(header(h.recorded.meta, 'x-actor-user-id')).toBe('user-1');
  });
});

describe('*** no request shape names another person (FR-013) ***', () => {
  const SRC = readFileSync(join(__dirname, 'ui-preferences.controller.ts'), 'utf8');

  it('every route path is literally `me/ui-preferences`', () => {
    const paths = [...SRC.matchAll(/@(?:Get|Patch|Post|Put|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toBe('me/ui-preferences');
  });

  it('no route takes a path parameter at all', () => {
    // A `:id` here is the parameter that makes reading someone else's settings possible. The guarantee
    // is its absence, so the absence is what is asserted.
    expect(SRC).not.toMatch(/@Param\(/);
    expect(SRC).not.toMatch(/@(?:Get|Patch|Post|Put|Delete)\('[^']*:/);
  });

  it('the subject is never read from the body or the query', () => {
    expect(SRC).not.toMatch(/@Query\(/);
    expect(SRC).not.toMatch(/\bauthUserId\b/);
    expect(SRC).not.toMatch(/\boperatorId\b/);
  });

  it('the detector would catch a subject route — proved on planted input', () => {
    // The three assertions above are `not.toMatch`, which pass on an empty file. Planting the shape
    // they are meant to catch is what shows they can fail.
    const planted = `@Get('operators/:operatorId/ui-preferences')`;
    expect(/@(?:Get|Patch|Post|Put|Delete)\('[^']*:/.test(planted)).toBe(true);
  });
});

describe('*** the edge validates SHAPE only, and never echoes a value ***', () => {
  it('passes a well-formed patch through unchanged', async () => {
    const h = harness();
    await h.ctl.patch({ values: { theme_mode: 'dark' } }, req());
    expect(h.recorded.args).toEqual({ values: { theme_mode: 'dark' } });
  });

  it.each([
    ['a missing body', undefined],
    ['a missing values map', {}],
    ['values as null', { values: null }],
    ['values as an array', { values: ['theme_mode'] }],
    ['values as a string', { values: 'theme_mode=dark' }],
    ['an empty values map', { values: {} }],
    ['a non-string value', { values: { theme_mode: 3 } }],
  ])('refuses %s with 400, calling the service not at all', async (_label, body) => {
    const h = harness();
    await expect(h.ctl.patch(body, req())).rejects.toBeInstanceOf(BadRequestException);
    expect(h.svc.updateOperatorUiPreferences).not.toHaveBeenCalled();
  });

  it('a shape refusal names the key and NEVER the submitted value', async () => {
    const h = harness();
    const err = await h.ctl
      .patch({ values: { theme_mode: { secret: 'user@example.com' } } }, req())
      .catch((e: unknown) => e);
    const text = JSON.stringify((err as BadRequestException).getResponse());
    expect(text).toContain('theme_mode');
    expect(text).not.toContain('user@example.com');
  });

  it('forwards an UNKNOWN key rather than judging it — the catalogue lives in the service', async () => {
    // Principle II: the owning service decides. A second copy of the catalogue's rules here is the
    // drift feature 017 found live, where two export vocabularies had already diverged.
    const h = harness();
    await h.ctl.patch({ values: { some_future_key: 'x' } }, req());
    expect(h.svc.updateOperatorUiPreferences).toHaveBeenCalled();
  });

  it('⚠️ a service refusal reaches the client WITH its detail — the live-only gap', async () => {
    // The shared `toHttp` is message-free on purpose (an uploads error could carry a filename). It
    // also swallowed the one detail this surface needs: the client received `invalid request` and a
    // settings screen could not say which control was wrong. Every offline test passed, because they
    // assert the service's exception and never cross the edge. Fourth occurrence of that class.
    const h = harness();
    h.svc.updateOperatorUiPreferences.mockImplementationOnce(() =>
      throwError(() => ({ code: 3, details: 'value not allowed for preference: theme_mode' })),
    );
    const err = await h.ctl.patch({ values: { theme_mode: 'purple' } }, req()).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain('theme_mode');
  });

  it('every OTHER failure class stays coarse — the pass-through is scoped to 400', async () => {
    const h = harness();
    for (const [code, expected] of [
      [5, 'not found'],
      [7, 'forbidden'],
      [16, 'unauthorized'],
    ] as const) {
      h.svc.updateOperatorUiPreferences.mockImplementationOnce(() =>
        throwError(() => ({ code, details: 'storage-key/secret/path' })),
      );
      const err = await h.ctl.patch({ values: { theme_mode: 'dark' } }, req()).catch((e) => e);
      const text = JSON.stringify((err as { getResponse(): unknown }).getResponse());
      expect(text).toContain(expected);
      // The 016 rule still holds everywhere else: no downstream detail escapes.
      expect(text).not.toContain('storage-key');
    }
  });

  it('an absurdly long upstream detail is NOT passed through', async () => {
    // A bound rather than trust: the pass-through is safe because of what the owning service
    // guarantees about its message, and a 4 KB body is evidence that guarantee stopped holding.
    const h = harness();
    h.svc.updateOperatorUiPreferences.mockImplementationOnce(() =>
      throwError(() => ({ code: 3, details: 'x'.repeat(4000) })),
    );
    const err = await h.ctl.patch({ values: { theme_mode: 'dark' } }, req()).catch((e) => e);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain('invalid request');
  });

  it('this edge names no preference key anywhere in its CODE', () => {
    // ⚠️ Comments stripped first. The controller explains, in prose, why a service refusal naming
    // `theme_mode` is safe to pass through — and that explanation is the most useful line in the
    // file. A guard banning the token outright would force its deletion. Third time this exact
    // collision appeared in one session, which is why `stripComments` is shared infrastructure.
    const code = stripComments(readFileSync(join(__dirname, 'ui-preferences.controller.ts'), 'utf8'));
    expect(code).not.toContain('theme_mode');
    expect(code).not.toContain('font_size_step');
    // …and the stripping is not simply removing everything.
    expect(code).toContain('me/ui-preferences');
  });
});

describe('*** the gateway does not become a second catalogue ***', () => {
  const ROOT = resolve(__dirname, '..', '..', '..', '..');

  it('no default preference value is hardcoded anywhere in the gateway', () => {
    const src = stripComments(
      readFileSync(
        join(ROOT, 'services', 'gateway', 'src', 'preferences', 'ui-preferences.controller.ts'),
        'utf8',
      ),
    );
    expect(src).not.toMatch(/default(?:UiPreferences|Preferences)\s*\(/);
    expect(src).not.toContain("'light'");
    expect(src).not.toContain("'compact'");
  });
});
