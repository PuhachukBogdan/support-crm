import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Metadata } from '@grpc/grpc-js';
import { AuditController } from './audit.controller';
import { AuditFederation, AuditSourceError } from './audit.federation';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

/**
 * T024 (feature 015, US1) — the audit REST edge. FAILS before it exists, PASSES after.
 *
 * Two properties, both about not misleading the reader:
 *  • an unrecognised filter is a **400 before any RPC**. Dropping it would widen the query to everything and
 *    look like a successful search — and on an audit log that is worse than an error, because the reader
 *    concludes something from a result that answered a different question.
 *  • an unreadable source is a **5xx, not a short page**. "No entries" must never be how "a third of the
 *    trail was unreachable" presents itself.
 */
function build(over: { list?: jest.Mock } = {}) {
  const list =
    over.list ?? jest.fn().mockResolvedValue({ entries: [], nextPageToken: '' });
  const federation = { list } as unknown as AuditFederation;
  return { ctrl: new AuditController(federation), list };
}

const req = (perms = ['platform.audit.view']) =>
  ({
    claims: { accountId: 'acc-1', userId: 'god', roles: ['super_admin'] },
    effective: { permissionKeys: perms },
  }) as never;

describe('the route is permission-gated', () => {
  it('declares platform.audit.view', () => {
    expect(new Reflector().get(REQUIRED_PERMISSION_KEY, AuditController.prototype.list as never)).toBe(
      'platform.audit.view',
    );
  });
});

describe('proxying', () => {
  it('passes the validated claims through as actor metadata', async () => {
    const { ctrl, list } = build();
    await ctrl.list(req());
    const md = list.mock.calls[0]![1] as Metadata;
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-user-id')[0]).toBe('god');
    expect(md.get('x-actor-permissions')[0]).toContain('platform.audit.view');
  });

  it('forwards every filter and clamps the page size', async () => {
    const { ctrl, list } = build();
    await ctrl.list(
      req(),
      'actor-1',
      'role.assign',
      undefined,
      'u-1',
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
      'tok',
      '5000',
    );
    expect(list.mock.calls[0]![0]).toMatchObject({
      actorUserId: 'actor-1',
      action: 'role.assign',
      targetRef: 'u-1',
      from: '2026-07-01T00:00:00Z',
      to: '2026-08-01T00:00:00Z',
      pageToken: 'tok',
      pageSize: 100, // capped
    });
  });

  it('defaults the page size when absent or nonsense', async () => {
    const { ctrl, list } = build();
    await ctrl.list(req());
    expect(list.mock.calls[0]![0].pageSize).toBe(50);
    await ctrl.list(req(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'abc');
    expect(list.mock.calls[1]![0].pageSize).toBe(50);
  });

  it('accepts a whole class as a filter', async () => {
    const { ctrl, list } = build();
    await ctrl.list(req(), undefined, undefined, 'privilege');
    expect(list.mock.calls[0]![0].actionClass).toBe('privilege');
  });
});

describe('*** an unrecognised filter is 400 BEFORE any RPC ***', () => {
  it.each([
    ['unknown action', ['actor', 'perm_grant']],
    ['legacy action spelling', ['actor', 'role_assign']],
  ])('%s', async (_label, [actor, action]) => {
    const { ctrl, list } = build();
    await expect(ctrl.list(req(), actor, action)).rejects.toBeInstanceOf(BadRequestException);
    expect(list).not.toHaveBeenCalled();
  });

  it('unknown class', async () => {
    const { ctrl, list } = build();
    await expect(ctrl.list(req(), undefined, undefined, 'everything')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('action and class together (they would contradict)', async () => {
    const { ctrl, list } = build();
    await expect(ctrl.list(req(), undefined, 'role.assign', 'privilege')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['last tuesday', 'not-a-date'])('unparseable timestamp %p', async (value) => {
    const { ctrl, list } = build();
    await expect(
      ctrl.list(req(), undefined, undefined, undefined, undefined, value),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('downstream failures are translated honestly', () => {
  it('*** an unreachable source is a 5xx, not an empty page ***', async () => {
    const { ctrl } = build({ list: jest.fn().mockRejectedValue(new AuditSourceError('users')) });
    const err = await ctrl.list(req()).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    // …and the message says the trail is partial rather than implying there was nothing to see.
    expect(JSON.stringify((err as InternalServerErrorException).getResponse())).toContain('unavailable');
  });

  it('a malformed page token is a 400', async () => {
    const { AuditCursorError } = await import('@crm/common');
    const { ctrl } = build({ list: jest.fn().mockRejectedValue(new AuditCursorError('bad')) });
    await expect(ctrl.list(req())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a downstream INVALID_ARGUMENT is a 400', async () => {
    const { ctrl } = build({
      list: jest.fn().mockRejectedValue(Object.assign(new Error('3'), { code: 3 })),
    });
    await expect(ctrl.list(req())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('anything else is a generic 500 with no downstream detail', async () => {
    const { ctrl } = build({
      list: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:50051')),
    });
    const err = (await ctrl.list(req()).catch((e) => e)) as InternalServerErrorException;
    expect(err).toBeInstanceOf(InternalServerErrorException);
    const body = JSON.stringify(err.getResponse());
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('10.0.0.5');
  });
});
