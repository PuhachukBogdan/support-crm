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
      select: { id: true, account_id: true, brand_id: true, kind: true, key: true, address: true },
    })) as (Omit<ChannelRow, 'kind'> & { kind: string }) | null;

    if (!row) return null;
    // A stored kind outside the vocabulary is a defect, not a channel: it can only have arrived by a
    // hand-written INSERT or a migration that missed a row, and guessing which kind was meant would file
    // a customer's message onto the wrong transport. Refuse it the way an unknown key is refused.
    if (!isChannelKind(row.kind)) return null;
    return { ...row, kind: row.kind };
  }

  /** The channels of one account — account-scoped, for the diagnostics and the live run. */
  async listForAccount(accountId: string): Promise<ChannelRow[]> {
    const rows = (await this.prisma.forAccount(accountId).channel.findMany({
      select: { id: true, account_id: true, brand_id: true, kind: true, key: true, address: true },
      orderBy: { key: 'asc' },
    })) as Array<Omit<ChannelRow, 'kind'> & { kind: string }>;
    return rows.filter((r): r is ChannelRow => isChannelKind(r.kind));
  }
}
