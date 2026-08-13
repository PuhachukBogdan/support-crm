import { Inject, Injectable } from '@nestjs/common';
import { isChannelKind, type ChannelKind } from '@crm/common';
import { PrismaService } from '../prisma.service';

export interface ChannelRow {
  id: string;
  account_id: string;
  brand_id: string;
  kind: ChannelKind;
  key: string;
  address: string | null;
  /**
   * W5 (subpoint 2.4): the DESK this channel's newly created tickets are pushed to — a soft ref to
   * auth.Group.id. NULL = not push-routed; intake then leaves the ticket unowned exactly as before,
   * which keeps "we have not decided where this channel routes" an honest state.
   */
  default_group_id: string | null;
  /** W15: the stop button, now visible on the admin screen. `resolveByKey` filters on it, so a row
   *  it returns always carries `true`. */
  enabled: boolean;
}

/**
 * The configured channels of one account (feature 033, roadmap 6.5).
 *
 * ── ⚠️ THIS REPOSITORY DECIDES WHICH TENANT AN ARRIVING TICKET BELONGS TO ────────────────────────
 * The row it returns supplies the account and the brand; the payload supplies neither (FR-011). That
 * makes `Channel` an **access input** rather than merely tenant data — the category `PlayerAssignment`
 * is in, one service over — and it is why `prisma.scoped-models.ts` lists it with that note.
 *
 * ── The one method that is NOT account-scoped, and why it is safe ────────────────────────────────
 * `resolveByKey` looks a channel up by key ALONE, because the caller is a stranger's delivery and there
 * is no account yet to scope to — finding out which account this is is the entire question. That is the
 * same shape as feature 009's pre-account login lookup and 010's activation read, and it is safe for the
 * same two reasons: the key is globally unique in practice (`@@unique([account_id, key])` plus keys that
 * are generated, not chosen), and **the account it returns then scopes everything downstream**. Nothing
 * else here reads across accounts.
 */
@Injectable()
export class ChannelRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Resolve the channel a delivery names.
   *
   * ⚠️ **A disabled channel returns `null`, exactly as an unknown one does.** Disabling is the operator's
   * stop button until the admin screen exists (roadmap 3.10 / W15), and a caller must not be able to tell
   * a retired key from a nonexistent one — the difference is the confirmation an attacker wants and the
   * one thing a legitimate integration never needs.
   */
  async resolveByKey(key: string): Promise<ChannelRow | null> {
    if (key.trim() === '') return null;
    const row = (await this.prisma.channel.findFirst({
      where: { key, enabled: true },
      select: {
        id: true,
        account_id: true,
        brand_id: true,
        kind: true,
        key: true,
        address: true,
        default_group_id: true,
        enabled: true,
      },
    })) as (Omit<ChannelRow, 'kind'> & { kind: string }) | null;

    if (!row) return null;
    // A stored kind outside the vocabulary is a defect, not a channel: it can only have arrived by a
    // hand-written INSERT or a migration that missed a row, and guessing which kind was meant would file
    // a customer's message onto the wrong transport. Refuse it the way an unknown key is refused.
    if (!isChannelKind(row.kind)) return null;
    return { ...row, kind: row.kind };
  }

  /** The channels of one account — account-scoped. W15's admin read (it now carries `enabled`,
   *  which is the difference between "configured" and "configured but stopped" on the screen). */
  async listForAccount(accountId: string): Promise<ChannelRow[]> {
    const rows = (await this.prisma.forAccount(accountId).channel.findMany({
      select: {
        id: true,
        account_id: true,
        brand_id: true,
        kind: true,
        key: true,
        address: true,
        default_group_id: true,
        enabled: true,
      },
      orderBy: { key: 'asc' },
    })) as Array<Omit<ChannelRow, 'kind'> & { kind: string }>;
    return rows.filter((r): r is ChannelRow => isChannelKind(r.kind));
  }

  /** W15: the email channel of ONE brand, if configured — the read the upsert decides on. */
  async emailChannelOf(accountId: string, brandId: string): Promise<ChannelRow | null> {
    const rows = await this.listForAccount(accountId);
    return rows.find((r) => r.brand_id === brandId && r.kind === 'email') ?? null;
  }

  /**
   * W15 (roadmap 6.8 minimum) — change an existing email channel's address, with its audit entry in
   * the same transaction (the `setBrand` shape: read → refuse → update+record; `updateMany` reports
   * 0 for an id that is not there, and the caller must treat that as NOT_FOUND, not success).
   */
  async setEmailAddress(
    accountId: string,
    channelId: string,
    address: string,
    auditStatement: unknown,
  ): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [res] = (await db.$transaction([
      db.channel.updateMany({ where: { id: channelId, kind: 'email' }, data: { address } }),
      auditStatement,
    ] as never)) as unknown as [{ count: number }];
    return res.count;
  }

  /**
   * W15 — create a brand's email channel, audit entry in the same transaction. The id is the
   * CALLER's (generated before the write, so the audit statement can name its target); the
   * `@@unique([account_id, brand_id, kind])` constraint turns a concurrent duplicate into a P2002
   * the caller maps to ALREADY_EXISTS rather than a second mailbox silently competing for mail.
   */
  async createEmailChannel(
    accountId: string,
    row: { id: string; brandId: string; key: string; address: string },
    auditStatement: unknown,
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction([
      db.channel.create({
        // `account_id` is also injected by the scoped client; stated here because the CREATE type
        // requires it — the two values are the same by construction.
        data: { id: row.id, account_id: accountId, brand_id: row.brandId, kind: 'email', key: row.key, address: row.address },
      }),
      auditStatement,
    ] as never);
  }
}
