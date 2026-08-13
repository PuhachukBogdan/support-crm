import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import {
  REQUIRED_PERMISSION_KEY,
  RESOLVE_PERMISSIONS_KEY,
} from '../security/requires-permission.decorator';
import { MeOperatorController } from './me-operator.controller';

/**
 * `GET /me/operator` (roadmap 5.11, MVP block W5).
 *
 * The point of this surface is a NEGATIVE guarantee — the subject cannot be pointed at anyone else —
 * so half of this file asserts absences, and the detector block proves the absences are detectable
 * (a `not.toMatch` passes on an empty file; the preferences edge beside this one set the idiom).
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

function harness(answer: Record<string, unknown> = {}) {
  const recorded: { meta?: unknown; args?: unknown; calls: number } = { calls: 0 };
  const svc = {
    ensureOwnOperator: jest.fn((d: unknown, md: unknown) => {
      recorded.calls += 1;
      recorded.args = d;
      recorded.meta = md;
      return of({ operatorId: 'op-1', displayName: 'Agent', active: true, ...answer });
    }),
  };
  const ctl = new MeOperatorController({ getService: () => svc } as never);
  ctl.onModuleInit();
  return { ctl, svc, recorded };
}

const req = (over: Record<string, unknown> = {}) =>
  ({ claims: CLAIMS, effective: effective(), ...over }) as never;

function header(meta: unknown, key: string): string | undefined {
  const got = (meta as { get?: (k: string) => unknown[] })?.get?.(key);
  const first = Array.isArray(got) ? got[0] : undefined;
  return typeof first === 'string' ? first : undefined;
}

describe('the caller gets their own operator identity', () => {
  it('answers with the resolved profile, restated field by field', async () => {
    const h = harness();
    await expect(h.ctl.get(req())).resolves.toEqual({
      operatorId: 'op-1',
      displayName: 'Agent',
      active: true,
      // ⭐ W19: the avatar reference joined the restated wire — '' when unset.
      avatarUploadId: '',
    });
  });

  it('sends an EMPTY request — the rpc message has no fields to point elsewhere', async () => {
    const h = harness();
    await h.ctl.get(req());
    expect(h.recorded.args).toEqual({});
  });

  it('identity travels as VALIDATED claims in metadata, never in the message', async () => {
    const h = harness();
    await h.ctl.get(req());
    expect(header(h.recorded.meta, 'x-actor-account-id')).toBe('acc-1');
    expect(header(h.recorded.meta, 'x-actor-user-id')).toBe('user-1');
  });

  it('a field the rpc grows later does NOT silently reach the browser', async () => {
    // The wire is restated, not spread — this is the assertion that keeps it that way.
    const h = harness({ presence: 'online' });
    const res = (await h.ctl.get(req())) as Record<string, unknown>;
    expect(res).not.toHaveProperty('presence');
  });
});

describe('*** ⚠️ the route resolves permissions and requires none ***', () => {
  it('`get` carries @ResolvesPermissions() — the preview marker travels only when it does', () => {
    expect(Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, MeOperatorController.prototype.get)).toBe(
      true,
    );
  });

  it('`get` requires NO permission key — asking who you are is not gated', () => {
    // If this starts failing, a permission has been introduced between an agent and their own
    // identity — which re-creates the exact gap 5.11 exists to close.
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, MeOperatorController.prototype.get),
    ).toBeUndefined();
  });

  it('the route list is derived from the controller, not typed out here', () => {
    const handlers = Object.getOwnPropertyNames(MeOperatorController.prototype).filter(
      (n) => n !== 'constructor' && n !== 'onModuleInit',
    );
    // ⭐ W19 added the avatar placement — still self-scoped, still permission-free by the same
    // reasoning the header states (the subject is the session; the capability is "have a face").
    expect(handlers).toEqual(['get', 'setAvatar']);
  });
});

describe('*** no request shape names another person ***', () => {
  const SRC = readFileSync(join(__dirname, 'me-operator.controller.ts'), 'utf8');

  it('every route path starts with `me/operator` — no segment can name anyone else', () => {
    const paths = [...SRC.matchAll(/@(?:Get|Patch|Post|Put|Delete)\('([^']*)'\)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(1);
    for (const p of paths) {
      expect(p?.startsWith('me/operator')).toBe(true);
      // Still no parameter anywhere on this surface — the isolation is the route table's shape.
      expect(p).not.toContain(':');
    }
  });

  it('no route takes a path parameter or a query; a body may reference only NON-person things', () => {
    // The guarantee is the ABSENCE of a way to name somebody: with no `:param` and no query there
    // is no edit that widens this into `operators/:id`.
    expect(SRC).not.toMatch(/@Param\(/);
    expect(SRC).not.toMatch(/@Query\(/);
    expect(SRC).not.toMatch(/@(?:Get|Patch|Post|Put|Delete)\('[^']*:/);
    /**
     * ⚠️ AMENDED by W19, which added the first `@Body` here — the avatar placement (`{uploadId}`).
     * The claim this file protects is *no request shape names another PERSON*; an upload reference
     * is not a person, so the body is admitted and the person-shaped field names stay forbidden in
     * every inline body type. The blanket `@Body` ban was the cheaper spelling of the same intent,
     * kept only while no route needed a body at all.
     */
    const bodyTypes = [...SRC.matchAll(/@Body\(\)\s*\w+:\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(bodyTypes.length).toBeGreaterThan(0); // the detector read something
    for (const t of bodyTypes) {
      expect(t).not.toMatch(/user_?id|operator_?id|auth_?user|email|subject/i);
    }
  });

  it('the detector would catch a subject route — proved on planted input', () => {
    const planted = `@Get('operators/:operatorId')`;
    expect(/@(?:Get|Patch|Post|Put|Delete)\('[^']*:/.test(planted)).toBe(true);
  });
});
