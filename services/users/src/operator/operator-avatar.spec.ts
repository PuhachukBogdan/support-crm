import { RpcException } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { OperatorProfileService } from './operator-profile.service';
import { OperatorProfileController } from './operator-profile.grpc.controller';

/**
 * ⭐ W19 (subpoint 5.4) — SetMyAvatar. The claims: the upload must be the CALLER's own `avatar`
 * upload (three refusals, and "not yours" answers exactly like "does not exist"); setting CLAIMS a
 * pending upload in the SAME transaction as the profile write; re-setting an already-claimed one is
 * an ordinary success, not a conflict.
 */

function fakePrisma(
  opts: {
    upload?: { id: string; purpose: string; uploader_user_id: string; state: string } | null;
    profile?: boolean;
  } = {},
) {
  const uploadUpdates: Array<Record<string, unknown>> = [];
  const operatorUpdates: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];
  const upload =
    opts.upload === undefined
      ? { id: 'up-1', purpose: 'avatar', uploader_user_id: 'u-me', state: 'pending' }
      : opts.upload;

  const scoped = {
    upload: {
      findFirst: async () => (upload ? { ...upload } : null),
      updateMany: (args: Record<string, unknown>) => {
        uploadUpdates.push(args);
        return { count: 1 };
      },
    },
    operator: {
      findFirst: async (args: { select?: Record<string, unknown> }) => {
        if (opts.profile === false) return null;
        if (args?.select && 'account_id' in args.select) {
          return {
            id: 'op-1',
            account_id: 'acc-1',
            display_name: 'Ann',
            active: true,
            avatar_upload_id: 'up-1',
          };
        }
        return { id: 'op-1' };
      },
      updateMany: (args: Record<string, unknown>) => {
        operatorUpdates.push(args);
        return { count: 1 };
      },
      create: async () => {
        throw new Error('not used');
      },
    },
    $transaction: async (statements: unknown[]) => {
      batches.push(statements);
      return statements;
    },
  };
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, uploadUpdates, operatorUpdates, batches };
}

const md = (): Metadata => {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'u-me');
  return m;
};

const build = (prisma: PrismaService) =>
  new OperatorProfileController(new OperatorProfileService(prisma));

describe('SetMyAvatar', () => {
  it('⭐ claims the pending upload AND writes the reference in ONE transaction', async () => {
    const { prisma, uploadUpdates, operatorUpdates, batches } = fakePrisma();
    const res = await build(prisma).setMyAvatar({ uploadId: 'up-1' }, md());

    expect(uploadUpdates[0]).toMatchObject({
      where: { id: 'up-1', state: 'pending' },
      data: expect.objectContaining({ state: 'claimed' }),
    });
    expect(operatorUpdates[0]).toMatchObject({ data: { avatar_upload_id: 'up-1' } });
    expect(batches[0]).toHaveLength(2);
    expect(res.avatarUploadId).toBe('up-1');
  });

  it('re-setting an already-claimed avatar is an ordinary success — the claim guard is a no-op', async () => {
    const { prisma } = fakePrisma({
      upload: { id: 'up-1', purpose: 'avatar', uploader_user_id: 'u-me', state: 'claimed' },
    });
    await expect(build(prisma).setMyAvatar({ uploadId: 'up-1' }, md())).resolves.toMatchObject({
      avatarUploadId: 'up-1',
    });
  });

  it.each([
    ['a nonexistent upload', { upload: null }],
    [
      'someone ELSE’s upload — same answer, no existence oracle',
      { upload: { id: 'up-1', purpose: 'avatar', uploader_user_id: 'u-other', state: 'pending' } },
    ],
    ['a caller with no profile row', { profile: false }],
  ])('⛔ %s answers NOT_FOUND', async (_name, opts) => {
    const { prisma, operatorUpdates } = fakePrisma(opts as never);
    await expect(build(prisma).setMyAvatar({ uploadId: 'up-1' }, md())).rejects.toThrow(
      RpcException,
    );
    expect(operatorUpdates).toHaveLength(0);
  });

  it('⛔ a message attachment cannot become a face — wrong purpose is its own refusal', async () => {
    const { prisma, operatorUpdates } = fakePrisma({
      upload: {
        id: 'up-1',
        purpose: 'message_attachment',
        uploader_user_id: 'u-me',
        state: 'claimed',
      },
    });
    await expect(build(prisma).setMyAvatar({ uploadId: 'up-1' }, md())).rejects.toThrow(
      RpcException,
    );
    expect(operatorUpdates).toHaveLength(0);
  });
});
