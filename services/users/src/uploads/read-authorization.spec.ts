import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { UploadsRepository } from './uploads.repository';
import { UploadsGrpcController } from './uploads.grpc.controller';
import { InMemoryObjectStore } from './object-store.fake';

/**
 * T042 (feature 016, US2) — **a link is not a key** (FR-010/FR-011 / SEC-10).
 *
 * Authorization is evaluated at REQUEST TIME against the requester's current account and
 * permissions. A reference that was once usable stops working the moment either changes — which is
 * the whole reason no presigned URL is issued anywhere in this feature: a signed URL moves the
 * decision to link-creation time and grants access to whoever holds it for the length of its window.
 *
 * ⚠️ Every cross-account and revoked-permission case is run against BOTH VARIANTS. The derivative is
 * a second key path and therefore the likeliest place to be under-guarded (FR-009b) — a thumbnail
 * that skips the check is still a leak, and it is the variant that renders in dense lists.
 */
const OURS = 'acc-1';
const THEIRS = 'acc-2';

const rows = [
  {
    id: 'up-ours',
    account_id: OURS,
    purpose: 'message_attachment',
    uploader_user_id: 'op-1',
    content_type: 'image/png',
    byte_size: 4,
    checksum_sha256: 'deadbeef',
    storage_key: `${OURS}/message_attachment/aaa`,
    display_name: 'shot.png',
    derivative_key: `${OURS}/message_attachment/aaa.thumb.webp`,
    derivative_byte_size: 2,
    state: 'pending',
    claimed_at: null,
    created_at: new Date('2026-07-29T10:00:00.000Z'),
  },
  {
    id: 'up-theirs',
    account_id: THEIRS,
    purpose: 'message_attachment',
    uploader_user_id: 'op-9',
    content_type: 'image/png',
    byte_size: 4,
    checksum_sha256: 'cafebabe',
    storage_key: `${THEIRS}/message_attachment/bbb`,
    display_name: 'their-secret.png',
    derivative_key: `${THEIRS}/message_attachment/bbb.thumb.webp`,
    derivative_byte_size: 2,
    state: 'pending',
    claimed_at: null,
    created_at: new Date('2026-07-29T11:00:00.000Z'),
  },
  {
    id: 'up-pdf',
    account_id: OURS,
    purpose: 'message_attachment',
    uploader_user_id: 'op-1',
    content_type: 'application/pdf',
    byte_size: 8,
    checksum_sha256: 'f00d',
    storage_key: `${OURS}/message_attachment/ccc`,
    display_name: 'receipt.pdf',
    derivative_key: null, // a PDF has no derivative — never a silent fallback to the original
    derivative_byte_size: null,
    state: 'pending',
    claimed_at: null,
    created_at: new Date('2026-07-29T12:00:00.000Z'),
  },
];

/** The feature-007 extension, reproduced: every operation is confined to one account. */
function fakePrisma() {
  const forAccount = jest.fn((acc: string) => ({
    upload: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => r.account_id === acc && r.id === where.id) ?? null),
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(rows.filter((r) => r.account_id === acc && where.id.in.includes(r.id))),
    },
  }));
  return { prisma: { forAccount } as unknown as PrismaService, forAccount };
}

function md(accountId: string, perms: string[] = ['crm.conversation.reply']): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

function controller() {
  const { prisma, forAccount } = fakePrisma();
  const store = new InMemoryObjectStore();
  for (const r of rows) {
    void store.put(r.storage_key, Uint8Array.from([1, 2, 3, 4]), r.content_type);
    if (r.derivative_key) void store.put(r.derivative_key, Uint8Array.from([9, 9]), 'image/webp');
  }
  return {
    ctrl: new UploadsGrpcController(new UploadsRepository(prisma, store)),
    store,
    forAccount,
  };
}

const ORIGINAL = 'UPLOAD_VARIANT_ORIGINAL';
const DERIVATIVE = 'UPLOAD_VARIANT_DERIVATIVE';

async function rejection(fn: () => Promise<unknown>): Promise<{ code: number }> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RpcException) return err.getError() as { code: number };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('the owner is served — both variants', () => {
  it.each([ORIGINAL, DERIVATIVE])('%s', async (variant) => {
    const { ctrl } = controller();
    const res = await ctrl.readUpload({ uploadId: 'up-ours', variant }, md(OURS));
    expect(res.content.byteLength).toBeGreaterThan(0);
    // The VERIFIED type, and for a derivative the type WE produced — never the original's.
    expect(res.contentType).toBe(variant === DERIVATIVE ? 'image/webp' : 'image/png');
  });
});

describe('*** a cross-account read returns nothing, and looks exactly like a nonexistent id ***', () => {
  it.each([ORIGINAL, DERIVATIVE])(
    '%s: not-yours and does-not-exist are the same answer',
    async (variant) => {
      const { ctrl } = controller();
      const notYours = await rejection(() =>
        ctrl.readUpload({ uploadId: 'up-theirs', variant }, md(OURS)),
      );
      const neverExisted = await rejection(() =>
        ctrl.readUpload({ uploadId: 'up-does-not-exist', variant }, md(OURS)),
      );
      // Identical code AND identical message: anything else is an existence oracle (FR-011).
      expect(notYours).toEqual(neverExisted);
    },
  );

  it('the other account’s bytes and filename never appear in the refusal', async () => {
    const { ctrl } = controller();
    const err = await rejection(() =>
      ctrl.readUpload({ uploadId: 'up-theirs', variant: ORIGINAL }, md(OURS)),
    );
    expect(JSON.stringify(err)).not.toContain('their-secret');
  });

  it('the read never leaves the caller’s account scope', async () => {
    const { ctrl, forAccount } = controller();
    await rejection(() => ctrl.readUpload({ uploadId: 'up-theirs', variant: ORIGINAL }, md(OURS)));
    expect(forAccount).toHaveBeenCalledWith(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
  });
});

describe('*** the same reference stops working when the permission is revoked *** (FR-010 / SC-006)', () => {
  it.each([ORIGINAL, DERIVATIVE])(
    '%s: served, then refused, with nothing else changed',
    async (variant) => {
      const { ctrl } = controller();
      // Before: the caller holds the purpose's key.
      const ok = await ctrl.readUpload({ uploadId: 'up-ours', variant }, md(OURS));
      expect(ok.content.byteLength).toBeGreaterThan(0);

      // After: the same id, the same account, the same everything — minus the permission.
      const err = await rejection(() =>
        ctrl.readUpload({ uploadId: 'up-ours', variant }, md(OURS, ['crm.inbox.view'])),
      );
      expect(err.code).toBe(7); // PERMISSION_DENIED
    },
  );

  it('a caller with NO permissions at all is refused', async () => {
    const { ctrl } = controller();
    const err = await rejection(() =>
      ctrl.readUpload({ uploadId: 'up-ours', variant: ORIGINAL }, md(OURS, [])),
    );
    expect(err.code).toBe(7);
  });

  it('a caller with no account context is refused before any lookup', async () => {
    const { ctrl, forAccount } = controller();
    const bare = new Metadata();
    bare.set('x-actor-permissions', 'crm.conversation.reply');
    await rejection(() => ctrl.readUpload({ uploadId: 'up-ours', variant: ORIGINAL }, bare));
    expect(forAccount).not.toHaveBeenCalled();
  });
});

describe('a derivative that does not exist is NOT_FOUND, never a silent fallback', () => {
  it('a PDF has no thumbnail, and the original is not served in its place', async () => {
    const { ctrl, store } = controller();
    const err = await rejection(() =>
      ctrl.readUpload({ uploadId: 'up-pdf', variant: DERIVATIVE }, md(OURS)),
    );
    expect(err.code).toBe(5); // NOT_FOUND
    // Falling back would serve a PDF to a caller that asked for an image and will render it as one.
    expect(store.ops.filter((o) => o.op === 'get')).toEqual([]);
  });

  it('the same PDF IS served as an original', async () => {
    const { ctrl } = controller();
    const res = await ctrl.readUpload({ uploadId: 'up-pdf', variant: ORIGINAL }, md(OURS));
    expect(res.contentType).toBe('application/pdf');
    // A PDF renders as an active document with its own scripting → never inline (research R7).
    expect(res.inlineSafe).toBe(false);
  });

  it('an unspecified variant reads the original rather than failing', async () => {
    const { ctrl } = controller();
    const res = await ctrl.readUpload(
      { uploadId: 'up-ours', variant: 'UPLOAD_VARIANT_UNSPECIFIED' },
      md(OURS),
    );
    expect(res.contentType).toBe('image/png');
  });
});

describe('*** an unknown purpose is refused HERE too, not only at the gateway *** (T056 / FR-002)', () => {
  it('CreateUpload refuses a purpose outside the catalogue', async () => {
    const { ctrl } = controller();
    const err = await rejection(() =>
      ctrl.createUpload(
        {
          purpose: 'nonsense',
          declaredContentType: 'image/png',
          filename: 'x.png',
          content: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        },
        md(OURS),
      ),
    );
    // A call that SKIPS the gateway must fail identically. The gateway's own refusal is a
    // convenience — this one is the guarantee (Principle II).
    expect(err.code).toBe(3); // INVALID_ARGUMENT
  });

  it('…and refuses it BEFORE the permission check, so a typo is not reported as a policy problem', async () => {
    const { ctrl } = controller();
    // No permissions at all, and an unknown purpose: the answer is still INVALID_ARGUMENT rather
    // than PERMISSION_DENIED, because "no such purpose" is the true and more useful answer.
    const err = await rejection(() =>
      ctrl.createUpload(
        {
          purpose: 'nonsense',
          declaredContentType: '',
          filename: '',
          content: Uint8Array.from([1]),
        },
        md(OURS, []),
      ),
    );
    expect(err.code).toBe(3);
  });

  it('an empty purpose is refused the same way — there is no permissive default', async () => {
    const { ctrl } = controller();
    const err = await rejection(() =>
      ctrl.createUpload(
        { purpose: '', declaredContentType: '', filename: '', content: Uint8Array.from([1]) },
        md(OURS),
      ),
    );
    expect(err.code).toBe(3);
  });
});

describe('DescribeUploads is account-scoped too', () => {
  it('an id from another account is simply absent from the result', async () => {
    const { ctrl } = controller();
    const res = await ctrl.describeUploads({ uploadIds: ['up-ours', 'up-theirs'] }, md(OURS));
    expect(res.uploads.map((u) => u.id)).toEqual(['up-ours']);
    expect(JSON.stringify(res)).not.toContain('their-secret');
  });

  it('more than 50 ids is refused rather than truncated', async () => {
    const { ctrl } = controller();
    const ids = Array.from({ length: 51 }, (_, i) => `u-${i}`);
    const err = await rejection(() => ctrl.describeUploads({ uploadIds: ids }, md(OURS)));
    expect(err.code).toBe(3); // INVALID_ARGUMENT
  });
});
