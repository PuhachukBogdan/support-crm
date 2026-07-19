import { withAccountScope, scopeArgs, AccountScopeError } from './account-scope';

/**
 * US1 (feature 007): the account-scope Prisma extension injects the caller's account_id into every
 * read/write/create on scoped models and fails closed without a context. Tested over a FAKE base
 * client that captures the args handed to the underlying query — Docker-independent (Track A).
 */

type OpParams = { model: string; operation: string; args: unknown; query: (a: unknown) => unknown };
type Extension = { query: { $allModels: { $allOperations: (p: OpParams) => unknown } } };
type Args = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/** Build a scoped client over a fake base, and return an invoker for the extension's query hook. */
function makeHarness(accountId: string, scopedModels: readonly string[]) {
  let ext: Extension | undefined;
  const fakeBase = {
    $extends(e: Extension) {
      ext = e;
      return { __scoped: true };
    },
  };
  const client = withAccountScope(fakeBase as never, accountId, { scopedModels });
  const run = (model: string, operation: string, args: unknown): Args => {
    let seen: unknown;
    const query = (a: unknown) => {
      seen = a;
      return 'OK';
    };
    ext!.query.$allModels.$allOperations({ model, operation, args, query });
    return seen as Args;
  };
  return { client, run };
}

describe('withAccountScope — fail-closed', () => {
  it('throws when accountId is empty (never builds an unscoped tenant client)', () => {
    expect(() => withAccountScope({ $extends: () => ({}) } as never, '', { scopedModels: ['Player'] })).toThrow(
      AccountScopeError,
    );
  });

  it('throws when accountId is nullish', () => {
    expect(() =>
      withAccountScope({ $extends: () => ({}) } as never, undefined as unknown as string, {
        scopedModels: ['Player'],
      }),
    ).toThrow(AccountScopeError);
  });

  it('returns the extended client for a valid accountId', () => {
    const { client } = makeHarness('acc-A', ['Player']);
    expect(client).toEqual({ __scoped: true });
  });
});

describe('scoped model — reads', () => {
  const { run } = makeHarness('acc-A', ['Player']);

  it.each(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'])(
    'injects account_id into where on %s',
    (op) => {
      const seen = run('Player', op, { where: { vip: true } });
      expect(seen.where).toEqual({ vip: true, account_id: 'acc-A' });
    },
  );

  it('adds where even when the caller supplied none', () => {
    const seen = run('Player', 'findMany', {});
    expect(seen.where).toEqual({ account_id: 'acc-A' });
  });

  it('a caller cannot widen past the account (account_id is forced last)', () => {
    const seen = run('Player', 'findMany', { where: { account_id: 'acc-B' } });
    expect(seen.where?.account_id).toBe('acc-A');
  });
});

describe('scoped model — writes', () => {
  const { run } = makeHarness('acc-A', ['Player']);

  it.each(['update', 'updateMany', 'delete', 'deleteMany'])('injects account_id into where on %s', (op) => {
    const seen = run('Player', op, { where: { player_id: 'p-1' }, data: { vip: true } });
    expect(seen.where).toEqual({ player_id: 'p-1', account_id: 'acc-A' });
  });
});

describe('scoped model — creates force account_id', () => {
  const { run } = makeHarness('acc-A', ['Player']);

  it('forces data.account_id on create', () => {
    const seen = run('Player', 'create', { data: { player_id: 'p-1', account_id: 'acc-B' } });
    expect((seen.data as Record<string, unknown>).account_id).toBe('acc-A');
  });

  it('forces account_id on every row of createMany (array)', () => {
    const seen = run('Player', 'createMany', { data: [{ player_id: 'p-1' }, { player_id: 'p-2' }] });
    expect((seen.data as Record<string, unknown>[]).every((d) => d.account_id === 'acc-A')).toBe(true);
  });

  it('upsert scopes where AND forces account_id in create + update', () => {
    const seen = run('Player', 'upsert', {
      where: { player_id: 'p-1' },
      create: { player_id: 'p-1' },
      update: { vip: true },
    });
    expect(seen.where?.account_id).toBe('acc-A');
    expect(seen.create?.account_id).toBe('acc-A');
    expect(seen.update?.account_id).toBe('acc-A');
  });
});

describe('non-scoped model is untouched', () => {
  it('passes a join-table op through unchanged', () => {
    const { run } = makeHarness('acc-A', ['Player']);
    const args = { where: { player_id: 'p-1', brand_id: 'bow' } };
    const seen = run('PlayerBrand', 'findMany', args);
    expect(seen).toEqual(args); // no account_id added
  });
});

describe('scopeArgs (pure core)', () => {
  it('is a no-op for a model not in the scoped set', () => {
    const args = { where: { x: 1 } };
    expect(scopeArgs('UserRole', 'findMany', args, 'acc-A', ['User'])).toEqual(args);
  });
});
