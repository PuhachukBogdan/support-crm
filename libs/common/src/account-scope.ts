/**
 * Tenant/account isolation invariant (feature 007, Constitution Principle I — NON-NEGOTIABLE).
 *
 * A single, audited Prisma **client extension** that injects the caller's `account_id` into every
 * read/write/create on account-scoped models, so a cross-account row is structurally unreachable —
 * even when a query omits the filter. Access is via a scoped client (each service's
 * `PrismaService.forAccount(accountId)`); constructing one without a context throws (fail-closed).
 *
 * In Prisma 6, `$use` middleware is deprecated → this uses the GA `query` extension. The arg-mutation
 * logic lives in the pure `scopeArgs` (fully unit-testable, no DB); `withAccountScope` is the thin
 * `$extends` wiring. Raw (`$queryRaw`/`$executeRaw`) bypasses extensions — an audited escape hatch
 * (health `SELECT 1` touches no tenant data; any future raw path over tenant data must self-scope).
 */

/** Thrown when a scoped client is requested without an account context (fail-closed). */
export class AccountScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountScopeError';
  }
}

/** Operations whose `where` is AND-merged with the account predicate (reads + targeted writes). */
const WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/**
 * Pure core: return account-scoped args for one model operation. Exposed for testing.
 * - Non-scoped models are returned unchanged.
 * - `account_id` is applied LAST (spread order), so a caller can only NARROW within the account,
 *   never widen past it (top-level fields are AND-combined by Prisma).
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  accountId: string,
  scopedModels: readonly string[],
): unknown {
  if (!scopedModels.includes(model)) return args;
  const a: AnyArgs = { ...((args as AnyArgs) ?? {}) };

  if (WHERE_OPS.has(operation)) {
    a.where = { ...(a.where ?? {}), account_id: accountId };
  }

  if (operation === 'create') {
    a.data = { ...((a.data as Record<string, unknown>) ?? {}), account_id: accountId };
  } else if (operation === 'createMany') {
    const d = a.data;
    a.data = Array.isArray(d)
      ? d.map((row) => ({ ...row, account_id: accountId }))
      : { ...((d as Record<string, unknown>) ?? {}), account_id: accountId };
  } else if (operation === 'upsert') {
    a.create = { ...(a.create ?? {}), account_id: accountId };
    a.update = { ...(a.update ?? {}), account_id: accountId };
  }

  return a;
}

/**
 * The account-scoped client returned by {@link withAccountScope}. Structurally the same client as
 * the base (same model delegates — `.player.findUnique`, etc.), only every scoped-model operation is
 * confined to the account. Kept as an alias so call sites keep full delegate typing.
 */
export type ScopedClient<T> = T;

/** The Prisma `$extends` query hook this extension installs. */
interface QueryHookParams {
  model: string;
  operation: string;
  args: unknown;
  query: (a: unknown) => unknown;
}

/**
 * Wrap a Prisma client so every scoped-model operation is confined to `accountId`.
 * @throws AccountScopeError when `accountId` is missing (fail-closed — never build an unscoped
 *   tenant client). The message names the missing CONTEXT, never row data or a tenant id.
 *
 * Typed generically over the client `T`: the concrete per-service `$extends` signature is complex,
 * so we invoke it through a narrow local cast and return `T` (the scoped client exposes the same
 * delegates as the base — see {@link ScopedClient}).
 */
export function withAccountScope<T>(
  base: T,
  accountId: string,
  config: { scopedModels: readonly string[] },
): ScopedClient<T> {
  if (!accountId) {
    throw new AccountScopeError('account context is required to access tenant data (fail-closed)');
  }
  const { scopedModels } = config;
  const extendable = base as unknown as { $extends: (extension: unknown) => unknown };
  return extendable.$extends({
    query: {
      $allModels: {
        $allOperations(params: QueryHookParams) {
          const { model, operation, args, query } = params;
          return query(scopeArgs(model, operation, args, accountId, scopedModels));
        },
      },
    },
  }) as ScopedClient<T>;
}
