import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * `ApiKey` persistence (W31 / feature 038, roadmap 3.17 — ADR 0043 §5).
 *
 * ── Every admin path is account-scoped, and exactly one path is not ─────────────────────────────
 * `list` / `byId` / `insert` / `revoke` / `rotate` go through `forAccount` (Principle I), so a key of
 * one account is unreachable from another however the id was obtained. {@link ApiKeysRepository.resolve}
 * and {@link ApiKeysRepository.markUsed} deliberately use the RAW client, for the same reason the 009
 * login lookup and the invite-by-token read do: **the machine caller has no account context yet.** It
 * presents `<id>.<secret>`; the account is a PROPERTY OF THE ROW, discovered by reading it. A scoped
 * read here would fail closed on a call that is perfectly legitimate.
 *
 * ⚠️ The row addressed that way is a uuid nobody can enumerate, and neither method returns tenant
 * data to a caller — `resolve` hands the row to the verifier, which refuses on a bad secret before
 * anything is done with it.
 *
 * ── The batch form of `$transaction`, on purpose ────────────────────────────────────────────────
 * The write methods take trailing statements (the audit entry) and commit them WITH the change, so a
 * refused entry refuses the act rather than leaving it unrecorded (feature 015, spec Q3). The batch
 * form is the one feature 013's live defect cannot recur in; nothing here needs a read inside the
 * transaction.
 */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  consumer: string;
  secret_hash: string;
  fingerprint: string;
  ip_allow_list: string[];
  rate_per_hour: number;
  active: boolean;
  rotated_from_id: string | null;
  last_used_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** What the service has decided BEFORE the row exists — id and fingerprint included (see the service). */
export interface NewApiKey {
  id: string;
  consumer: string;
  secretHash: string;
  fingerprint: string;
  ipAllowList: string[];
  ratePerHour: number;
  createdBy: string;
  rotatedFromId?: string | null;
}

// `account_id` is also injected by the scoped client; stated here because the CREATE type requires
// it (the channel repository's note, same reason).
function toData(accountId: string, key: NewApiKey) {
  return {
    account_id: accountId,
    id: key.id,
    consumer: key.consumer,
    secret_hash: key.secretHash,
    fingerprint: key.fingerprint,
    ip_allow_list: key.ipAllowList,
    rate_per_hour: key.ratePerHour,
    created_by: key.createdBy,
    rotated_from_id: key.rotatedFromId ?? null,
  };
}

@Injectable()
export class ApiKeysRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The account's keys, newest first — the screen's order and the only read it needs. */
  async list(accountId: string): Promise<ApiKeyRow[]> {
    return (await this.prisma.forAccount(accountId).apiKey.findMany({
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    })) as unknown as ApiKeyRow[];
  }

  /** One key OF THIS ACCOUNT. `findFirst`, not `findUnique`: the scope predicate must apply. */
  async byId(accountId: string, id: string): Promise<ApiKeyRow | null> {
    return (await this.prisma.forAccount(accountId).apiKey.findFirst({
      where: { id },
    })) as unknown as ApiKeyRow | null;
  }

  /** The verification read — see the class banner for why it carries no account context. */
  async resolve(id: string): Promise<ApiKeyRow | null> {
    return (await this.prisma.apiKey.findUnique({
      where: { id },
    })) as unknown as ApiKeyRow | null;
  }

  async insert(accountId: string, key: NewApiKey, ...alsoInTransaction: unknown[]): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction([
      db.apiKey.create({ data: toData(accountId, key) }),
      ...alsoInTransaction,
    ] as never);
  }

  /**
   * Revoke, returning how many rows actually changed.
   *
   * `updateMany` rather than `update`: revoking an already-revoked key must be a no-op answer, not a
   * P2025 the caller has to catch — a repeated revocation is not an error (contract §C).
   */
  async revoke(accountId: string, id: string, ...alsoInTransaction: unknown[]): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [result] = (await db.$transaction([
      db.apiKey.updateMany({ where: { id, active: true }, data: { active: false } }),
      ...alsoInTransaction,
    ] as never)) as unknown as [{ count: number }];
    return result?.count ?? 0;
  }

  /**
   * Revoke the predecessor and write the replacement in ONE transaction.
   *
   * ⚠️ **The order is the constraint, not a preference.** `ApiKey_one_active_per_consumer` is a
   * partial unique index on `(account_id, consumer) WHERE active`; creating the new row first would
   * collide with the row it is about to replace. Revoke, then create.
   */
  async rotate(
    accountId: string,
    previousId: string,
    replacement: NewApiKey,
    ...alsoInTransaction: unknown[]
  ): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [result] = (await db.$transaction([
      db.apiKey.updateMany({ where: { id: previousId, active: true }, data: { active: false } }),
      db.apiKey.create({ data: toData(accountId, replacement) }),
      ...alsoInTransaction,
    ] as never)) as unknown as [{ count: number }];
    return result?.count ?? 0;
  }

  /** Written on ACCEPTED calls only — a refused call must not make a dead key look alive. */
  async markUsed(id: string, at: Date): Promise<void> {
    await this.prisma.apiKey.updateMany({ where: { id }, data: { last_used_at: at } });
  }
}
