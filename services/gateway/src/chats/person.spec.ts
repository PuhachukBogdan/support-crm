import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { PersonController } from './person.controller';
import { ChatsModule } from './chats.module';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import { stripComments } from '@crm/common';

function makeCtrl() {
  const getPersonFeed = jest.fn().mockReturnValue(of({ conversations: [], nextPageToken: '' }));
  const getPersonContactSummary = jest.fn().mockReturnValue(
    of({
      lastInboundAt: '',
      lastOutboundAt: '',
      lastContactAt: '',
      conversationCount: 0,
      countsByStatus: [],
      channels: [],
    }),
  );
  const client = {
    getService: () => ({ getPersonFeed, getPersonContactSummary }),
  } as unknown as ClientGrpc;
  const ctrl = new PersonController(client);
  ctrl.onModuleInit();
  return { ctrl, getPersonFeed, getPersonContactSummary };
}

const req = (permissionKeys = ['crm.inbox.view', 'crm.contact.view']) =>
  ({
    claims: { accountId: 'acc-1', userId: 'op-1', roles: ['am'] },
    effective: { permissionKeys },
  }) as never;

/**
 * Feature 022 (roadmap 4.13), T045 — **the person-level edge.**
 *
 * Two properties matter here and neither is about the happy path:
 *
 *  1. the actor's permissions REACH the service (feature 016's live-only defect: a route with no
 *     permission metadata makes the gateway forward an empty set, and the owning service then correctly
 *     refuses everything — four times now in this product: 4.9, 5.1, 5.2, 5.6);
 *  2. the gateway stays a proxy. Membership resolution and aggregation belong to `chats`, which owns the
 *     conversations. A gateway that resolved members and called per member would be business logic at the
 *     edge (Principle VIII) AND an N+1 across services — asserted structurally below, not by reading.
 */
describe('PersonController (gateway proxy, feature 022)', () => {
  it('proxies the person feed with paging and the actor metadata', async () => {
    const { ctrl, getPersonFeed } = makeCtrl();
    await ctrl.feed('person-1', { pageSize: '25' }, req());
    const [arg, md] = getPersonFeed.mock.calls[0] as [
      { personId: string; pageSize: number },
      Metadata,
    ];
    expect(arg.personId).toBe('person-1');
    expect(arg.pageSize).toBe(25);
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
  });

  it('proxies the person contact summary — no brand, because a person is not brand-scoped', async () => {
    const { ctrl, getPersonContactSummary } = makeCtrl();
    await ctrl.contactSummary('person-1', req());
    const [arg] = getPersonContactSummary.mock.calls[0] as [Record<string, unknown>];
    expect(arg).toEqual({ personId: 'person-1' });
    // A brand here would be a category error: the whole point of the person level is that it spans them.
    expect(Object.keys(arg)).not.toContain('brandId');
  });

  it('both routes declare crm.inbox.view — which is ALSO what makes permissions reach the service', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRED_PERMISSION_KEY, PersonController.prototype.feed)).toBe(
      'crm.inbox.view',
    );
    expect(reflector.get(REQUIRED_PERMISSION_KEY, PersonController.prototype.contactSummary)).toBe(
      'crm.inbox.view',
    );
  });

  it('the forwarded metadata carries the caller’s permission keys, INCLUDING crm.contact.view', async () => {
    // The person level needs both keys, and the second one is enforced by `users` on exactly these
    // forwarded credentials when membership is resolved. If the header arrived empty, `users` would refuse
    // every person read — feature 016's defect, in a new place.
    const { ctrl, getPersonFeed } = makeCtrl();
    await ctrl.feed('person-1', {}, req(['crm.inbox.view', 'crm.contact.view']));
    const [, md] = getPersonFeed.mock.calls[0] as [unknown, Metadata];
    const forwarded = md.get('x-actor-permissions')[0] as string;
    expect(forwarded).toContain('crm.inbox.view');
    expect(forwarded).toContain('crm.contact.view');
  });

  it('a caller WITHOUT crm.contact.view still has its (lack of) permission forwarded faithfully', async () => {
    // The gateway does not pre-judge the second key: it forwards what the caller holds and lets the owning
    // service refuse. Checking it here as well would be a second enforcement point that can drift; checking
    // it ONLY here would be worse, since a direct gRPC caller would bypass it entirely.
    const { ctrl, getPersonFeed } = makeCtrl();
    await ctrl.feed('person-1', {}, req(['crm.inbox.view']));
    const [, md] = getPersonFeed.mock.calls[0] as [unknown, Metadata];
    expect(md.get('x-actor-permissions')[0]).not.toContain('crm.contact.view');
  });

  /**
   * ⚠️ No "carries no brand-scope header" assertion here either — see the note in
   * `contact-summary.spec.ts`. The token is banned from the source by a standing guard that exempts only
   * the two specs testing the metadata builder itself; a per-route copy would cost a new exemption every
   * time a route is added, which is exactly how that guard would be widened into uselessness.
   *
   * A person read has no brand to scope by in any case: spanning brands is the whole point of it.
   */

  it('is registered in the chats module (an unregistered controller serves nothing)', () => {
    const controllers = (Reflect.getMetadata('controllers', ChatsModule) ?? []) as unknown[];
    expect(controllers).toContain(PersonController);
  });
});

/**
 * FR-032 — the gateway holds no member resolution and no aggregation.
 *
 * A structural scan rather than a reading of this one file: the requirement is about the whole edge, and
 * the tempting implementation ("fetch the members here, then call the player endpoint per member") would
 * pass a test that only looked at `person.controller.ts` while being exactly what must not exist.
 */
describe('FR-032 — the gateway proxies; it does not resolve membership or aggregate', () => {
  const GATEWAY_SRC = resolve(__dirname, '..');

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) yield full;
    }
  }

  /**
   * ⚠️ **Comments are stripped first, and this guard proved why on its first run.**
   *
   * It flagged `person.controller.ts` — because that file's header EXPLAINS the history: *"`users.
   * ListPersonMembers` waited on the other side with no caller"*. The note documenting why the call belongs
   * in `chats` is exactly the note a token ban would delete, and that note is the most valuable line in the
   * file. Fourth instance of this collision in the project; `stripComments` is shared for that reason.
   */
  const sources = [...walk(GATEWAY_SRC)].map((f) => ({
    f,
    src: stripComments(readFileSync(f, 'utf8')),
  }));

  it('the scan reached the gateway source (a guard that scans nothing must fail)', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some(({ f }) => f.endsWith('person.controller.ts'))).toBe(true);
  });

  it('nothing in the gateway calls ListPersonMembers', () => {
    // Identity crosses from `chats` to `users`, once, on the caller's credentials. A second caller here
    // would be a second place where that permission is evaluated.
    const offenders = sources
      .filter(({ src }) => /listPersonMembers/i.test(src))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it('the detector still fires on a real call (so stripping comments did not disarm it)', () => {
    // The other half of the repair: having excluded comments, prove the guard can still fail. Otherwise
    // "no offenders" would be indistinguishable from "nothing is being checked".
    const planted = stripComments(
      '// users.ListPersonMembers is mentioned here\nawait this.users.listPersonMembers({ personId });',
    );
    expect(/listPersonMembers/i.test(planted)).toBe(true);
    expect(/listPersonMembers/i.test(stripComments('// users.ListPersonMembers only in a note'))).toBe(
      false,
    );
  });

  it('nothing in the gateway aggregates or fans out over members', () => {
    const offenders = sources
      .filter(({ src }) => /getPlayerContactSummary\s*\([^)]*\)\s*\)?\s*\)?[\s\S]{0,80}map\(/.test(src))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  it('the person controller’s handlers are one-liners that forward and return', () => {
    const src = readFileSync(join(GATEWAY_SRC, 'chats', 'person.controller.ts'), 'utf8');
    // No loop, no accumulation, no arithmetic on the response.
    expect(src).not.toMatch(/\bfor\s*\(|\.reduce\(|Promise\.all/);
  });
});
