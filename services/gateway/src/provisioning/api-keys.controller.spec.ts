import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { AdminApiKeysController } from './api-keys.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

/**
 * ⭐ W31 (roadmap 3.17) — the admin edge for integration keys.
 *
 * Two things are worth a test here and the rest is plumbing: that **every** route is permission-gated
 * (a screen that hides a button proves nothing about a crafted request), and that an **empty address
 * allow-list survives the trip** — because it is a legal value meaning «nobody», and an edge that
 * read it as «unspecified» would widen a fail-closed list to everybody at the exact moment an admin
 * was being most careful.
 */

const KEY = {
  id: 'k-1',
  consumer: 'HR platform',
  fingerprint: 'fp_a1b2c3d4e5f6',
  ipAllowList: ['203.0.113.7'],
  ratePerHour: 60,
  active: true,
};

function harness(answers: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const svc = {
    listApiKeys: () => of(answers.list ?? { keys: [KEY] }),
    issueApiKey: (d: Record<string, unknown>) => {
      sent.push(d);
      return (answers.issue as never) ?? of({ key: KEY, value: 'k-1.the-secret' });
    },
    rotateApiKey: (d: Record<string, unknown>) => {
      sent.push(d);
      return (answers.rotate as never) ?? of({ key: KEY, value: 'k-1.a-new-secret' });
    },
    revokeApiKey: (d: Record<string, unknown>) => {
      sent.push(d);
      return (answers.revoke as never) ?? of({ revoked: true });
    },
  };
  const ctrl = new AdminApiKeysController({ getService: () => svc } as never);
  ctrl.onModuleInit();
  return { ctrl, sent };
}

const req = (body: unknown = {}) =>
  ({
    claims: { accountId: 'acc-1', userId: 'u-1', roles: ['admin'] },
    effective: { permissionKeys: ['platform.settings.manage'], roleKey: 'admin' },
    body,
  }) as never;

describe('*** ⭐ every route on this surface is permission-gated, server-side ***', () => {
  const reflector = new Reflector();
  it.each(['list', 'issue', 'rotate', 'revoke'])('%s requires platform.settings.manage', (method) => {
    const handler = (AdminApiKeysController.prototype as unknown as Record<string, () => unknown>)[method];
    expect(reflector.get<string>(REQUIRED_PERMISSION_KEY, handler!)).toBe('platform.settings.manage');
  });
});

describe('the collection answers under a NAME', () => {
  it('list answers `{ keys }`, never a bare array', async () => {
    const { ctrl } = harness();
    // A bare array cannot grow a sibling field later without breaking every reader; the screen's own
    // registry entry names this collection, so the two halves agree by contract rather than by luck.
    expect(await ctrl.list(req())).toEqual({ keys: [KEY] });
  });
});

describe('*** ⭐ an EMPTY allow-list is a value, not an omission ***', () => {
  it('forwards `[]` unchanged — it means «nobody», and the list is fail-closed', async () => {
    const { ctrl, sent } = harness();
    await ctrl.issue(req({ consumer: 'HR platform', ipAllowList: [], ratePerHour: 60 }));
    expect(sent[0]!.ipAllowList).toEqual([]);
  });

  it('a missing list also forwards as `[]` — the same fail-closed value, never a wildcard', async () => {
    const { ctrl, sent } = harness();
    await ctrl.issue(req({ consumer: 'HR platform' }));
    expect(sent[0]!.ipAllowList).toEqual([]);
  });
});

describe('refusals arrive as the status the screen already reads', () => {
  it.each([
    ['a duplicate consumer', GrpcStatus.ALREADY_EXISTS, 409],
    ['rotating a revoked key', GrpcStatus.FAILED_PRECONDITION, 409],
    ['an unknown key', GrpcStatus.NOT_FOUND, 404],
    ['an empty consumer', GrpcStatus.INVALID_ARGUMENT, 400],
  ])('%s ⇒ %s', async (_name, code, http) => {
    const failing = throwError(() => ({ code, details: 'refused' }));
    const { ctrl } = harness({ issue: failing, rotate: failing, revoke: failing });
    const call = code === GrpcStatus.FAILED_PRECONDITION ? ctrl.rotate('k-1', req()) : ctrl.issue(req({ consumer: 'x' }));
    await expect(call).rejects.toMatchObject({ status: http });
  });
});

describe('revoking twice is a no-op, not an error', () => {
  it('answers `revoked: false` rather than 404 on the second call', async () => {
    const { ctrl } = harness({ revoke: of({ revoked: false }) });
    // The row survives revocation for the journal, so a 404 would be a lie about something the admin
    // can still see on the screen in front of them.
    expect(await ctrl.revoke('k-1', req())).toEqual({ revoked: false });
  });
});

describe('*** the one-shot value passes through and stops nowhere ***', () => {
  it('issue and rotate return it; nothing in this file stores or logs it', async () => {
    const { ctrl } = harness();
    expect(await ctrl.issue(req({ consumer: 'HR platform' }))).toEqual({ key: KEY, value: 'k-1.the-secret' });
    expect(await ctrl.rotate('k-1', req())).toEqual({ key: KEY, value: 'k-1.a-new-secret' });
    // And the list — the only re-readable surface — carries no `value` member at all. The absence is
    // the protection; a redaction step is something somebody has to remember (ADR 0043 §5).
    const listed = (await ctrl.list(req())) as { keys: Record<string, unknown>[] };
    expect(Object.keys(listed.keys[0]!)).not.toContain('value');
  });
});
