import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../src/prisma.service';
import { UploadsRepository } from '../src/uploads/uploads.repository';
import { UploadsGrpcController } from '../src/uploads/uploads.grpc.controller';
import { InMemoryObjectStore } from '../src/uploads/object-store.fake';

/**
 * T057 (feature 016) — cross-account isolation for uploads (Principle I / SC-005 / FR-018).
 *
 * The trap is deliberate: both accounts hold an upload with the same PURPOSE and the same shape, and
 * the fake `forAccount(acc)` reproduces what the feature-007 extension does — it confines every
 * operation to one account. So "not visible" here is the STRUCTURAL outcome of scoping, not a filter
 * applied afterwards, and a regression that removed `forAccount` would fail these tests rather than
 * quietly widening every query.
 *
 * All three verbs are covered, not just the read. A claim MUTATES, and an isolation bug on a write
 * path is worse than one on a read: it does not leak a neighbour's file, it takes it.
 */
const OURS = 'acc-1';
const THEIRS = 'acc-2';

interface Row {
  id: string;
  account_id: string;
  purpose: string;
  state: string;
  [k: string]: unknown;
}

function makeRows(): Row[] {
  const base = {
    purpose: 'message_attachment',
    uploader_user_id: 'op-1',
    content_type: 'image/png',
    byte_size: 4,
    checksum_sha256: 'abc',
    display_name: 'shot.png',
    derivative_key: null,
    derivative_byte_size: null,
    state: 'pending',
    claimed_at: null,
    created_at: new Date('2026-07-29T10:00:00.000Z'),
  };
  return [
    { ...base, id: 'up-ours', account_id: OURS, storage_key: `${OURS}/message_attachment/a` },
    {
      ...base,
      id: 'up-theirs',
      account_id: THEIRS,
      storage_key: `${THEIRS}/message_attachment/b`,
      display_name: 'their-invoice.png',
    },
  ];
}

function harness() {
  const rows = makeRows();
  const updates: Array<{ account: string; ids: string[] }> = [];

  const scopedFor = (acc: string) => {
    const own = () => rows.filter((r) => r.account_id === acc);
    const scoped = {
      upload: {
        findFirst: ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(own().find((r) => r.id === where.id) ?? null),
        findMany: ({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(own().filter((r) => where.id.in.includes(r.id))),
        updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const ids = (where.id as { in: string[] }).in;
          // The repository writes `account_id` into the predicate explicitly AND runs through the
          // scoped client. Honour both here, so the test cannot pass on only one of them.
          const target = rows.filter(
            (r) =>
              r.account_id === acc &&
              r.account_id === where.account_id &&
              ids.includes(r.id) &&
              r.state === where.state,
          );
          for (const r of target) Object.assign(r, data);
          updates.push({ account: acc, ids: target.map((r) => r.id) });
          return Promise.resolve({ count: target.length });
        },
      },
    } as Record<string, unknown>;
    (scoped as { $transaction: unknown }).$transaction = async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(scoped) : [];
    return scoped;
  };

  const forAccount = jest.fn((acc: string) => scopedFor(acc));
  const prisma = { forAccount } as unknown as PrismaService;
  const store = new InMemoryObjectStore();
  for (const r of rows) void store.put(r.storage_key as string, Uint8Array.from([1, 2, 3, 4]), 'image/png');
  return {
    ctrl: new UploadsGrpcController(new UploadsRepository(prisma, store)),
    rows,
    updates,
    forAccount,
    store,
  };
}

function md(accountId: string, perms = ['crm.conversation.reply']): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

async function refusal(fn: () => Promise<unknown>): Promise<{ code: number }> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RpcException) return err.getError() as { code: number };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('a cross-account READ returns nothing', () => {
  it('the neighbour’s upload is invisible, and its filename never appears', async () => {
    const { ctrl } = harness();
    const err = await refusal(() =>
      ctrl.readUpload({ uploadId: 'up-theirs', variant: 'UPLOAD_VARIANT_ORIGINAL' }, md(OURS)),
    );
    expect(err.code).toBe(5); // NOT_FOUND — same answer as "does not exist"
    expect(JSON.stringify(err)).not.toContain('their-invoice');
  });

  it('and the object is never fetched for it', async () => {
    const { ctrl, store } = harness();
    await refusal(() =>
      ctrl.readUpload({ uploadId: 'up-theirs', variant: 'UPLOAD_VARIANT_ORIGINAL' }, md(OURS)),
    );
    // The refusal happens on the ROW, before any storage access — so a scoping bug cannot be
    // "we fetched it but did not return it".
    expect(store.ops.filter((o) => o.op === 'get')).toEqual([]);
  });
});

describe('a cross-account DESCRIBE returns nothing', () => {
  it('the neighbour’s id is simply absent, not an error', async () => {
    const { ctrl } = harness();
    const res = await ctrl.describeUploads({ uploadIds: ['up-ours', 'up-theirs'] }, md(OURS));
    expect(res.uploads.map((u) => u.id)).toEqual(['up-ours']);
    expect(JSON.stringify(res)).not.toContain('their-invoice');
  });
});

describe('*** a cross-account CLAIM mutates nothing ***', () => {
  it('the neighbour’s upload stays pending and the whole call is refused', async () => {
    const { ctrl, rows } = harness();
    const err = await refusal(() =>
      ctrl.claimUploads({ uploadIds: ['up-theirs'], claimedBy: 'chats:message' }, md(OURS)),
    );
    expect(err.code).toBe(9); // FAILED_PRECONDITION
    expect(rows.find((r) => r.id === 'up-theirs')!.state).toBe('pending');
  });

  it('a MIXED claim takes neither — all-or-nothing across the boundary', async () => {
    const { ctrl, rows } = harness();
    await refusal(() =>
      ctrl.claimUploads({ uploadIds: ['up-ours', 'up-theirs'], claimedBy: 'chats:message' }, md(OURS)),
    );
    // The one we DO own must also be untouched: a partial claim would strand it as `claimed` with
    // nothing referencing it, and the refusal would look like nothing happened.
    expect(rows.map((r) => r.state)).toEqual(['pending', 'pending']);
  });

  it('a legitimate claim succeeds, so the tests above are not passing vacuously', async () => {
    const { ctrl, rows } = harness();
    const res = await ctrl.claimUploads({ uploadIds: ['up-ours'], claimedBy: 'chats:message' }, md(OURS));
    expect(res.uploadIds).toEqual(['up-ours']);
    expect(rows.find((r) => r.id === 'up-ours')!.state).toBe('claimed');
  });
});

describe('every operation goes through the account-scoped client', () => {
  it.each([
    ['read', (c: ReturnType<typeof harness>['ctrl']) => c.readUpload({ uploadId: 'up-ours', variant: 'UPLOAD_VARIANT_ORIGINAL' }, md(OURS))],
    ['describe', (c: ReturnType<typeof harness>['ctrl']) => c.describeUploads({ uploadIds: ['up-ours'] }, md(OURS))],
    ['claim', (c: ReturnType<typeof harness>['ctrl']) => c.claimUploads({ uploadIds: ['up-ours'], claimedBy: 'x' }, md(OURS))],
  ])('%s scopes to the caller and never to another account', async (_name, run) => {
    const { ctrl, forAccount } = harness();
    await run(ctrl);
    expect(forAccount).toHaveBeenCalledWith(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
  });

  it('no account context means no data path at all (fail-closed)', async () => {
    const { ctrl, forAccount } = harness();
    const bare = new Metadata();
    bare.set('x-actor-permissions', 'crm.conversation.reply');
    await refusal(() => ctrl.describeUploads({ uploadIds: ['up-ours'] }, bare));
    expect(forAccount).not.toHaveBeenCalled();
  });
});
