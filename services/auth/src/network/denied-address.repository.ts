import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * `DeniedAddress` persistence (W32 / feature 039, roadmap 12.10 — research D4).
 *
 * ── Every ADMIN path is account-scoped, and exactly one path is not ─────────────────────────────
 * `list` / `byId` / `insert` / `remove` go through `forAccount` (Principle I), so one account's list
 * is unreachable from another however the id was obtained. {@link DeniedAddressRepository.listAllForEdge}
 * deliberately uses the RAW client, and it is worth being precise about why that is not a hole:
 *
 *   The requirement is to refuse **before authentication** (FR-025). An unauthenticated request
 *   carries **no account at all** — there is nothing to scope by at the moment the decision is made.
 *   A scoped read here would need an account context that provably does not exist yet, so it could
 *   only be faked. The union across the deployment is therefore not a widening of what the caller may
 *   see; it is the only thing the question can mean at that point in the request's life.
 *
 * ⚠️ Two properties keep it honest. First, this method returns **addresses only** — no id, no note, no
 * `created_by`, no account — so a caller learns that a string is banned somewhere and nothing about
 * whose list it sits on. Second, the only caller is the gateway's cache refresh on a machine surface
 * (`AuthMaintenanceService.ListDeniedAddressesForEdge`), gated on the actor KIND, with no route.
 *
 * The precedent for a deliberate, written-down scope bypass is `api-keys.repository.ts`
 * (`resolve` / `markUsed` — the machine caller has no account context yet) and feature 009's login
 * lookup (the email is presented before anybody knows which account it belongs to). This is the third
 * instance of the same shape, and like the other two it is stated rather than discovered.
 *
 * ⛔ Today the product runs one operating account, so the union IS that account's list. If a second
 * operating account ever exists, one account's list could refuse another account's users — named here
 * and in research D4 as the thing to revisit, rather than left to be found.
 *
 * ── The batch form of `$transaction`, on purpose ────────────────────────────────────────────────
 * The write methods take trailing statements (the audit entry) and commit them WITH the change, so a
 * refused entry refuses the act rather than leaving it unrecorded (feature 015, spec Q3). The batch
 * form is the one feature 013's live defect cannot recur in; nothing here needs a read inside the
 * transaction.
 *
 * There is no logger in this module, and there must not be: addresses pass through it (the
 * `api-keys/` precedent — the cheapest structure is one that never acquired a line to leak through).
 */
export interface DeniedAddressRow {
  id: string;
  account_id: string;
  /** The NORMALISED form — see the service for why the raw form is never stored. */
  address: string;
  note: string | null;
  created_by: string;
  created_at: Date;
}

/** What the service has decided BEFORE the row exists — the id included (the api-keys precedent). */
export interface NewDeniedAddress {
  id: string;
  address: string;
  note: string;
  createdBy: string;
}

// `account_id` is also injected by the scoped client; stated here because the CREATE type requires it
// (the channel repository's note, same reason).
function toData(accountId: string, entry: NewDeniedAddress) {
  return {
    account_id: accountId,
    id: entry.id,
    address: entry.address,
    // '' is stored as NULL: the column is nullable and «no note» has one representation, not two.
    note: entry.note === '' ? null : entry.note,
    created_by: entry.createdBy,
  };
}

@Injectable()
export class DeniedAddressRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The account's list, newest first — the screen's order and the only read it needs. */
  async list(accountId: string): Promise<DeniedAddressRow[]> {
    return (await this.prisma.forAccount(accountId).deniedAddress.findMany({
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    })) as unknown as DeniedAddressRow[];
  }

  /** One row OF THIS ACCOUNT. `findFirst`, not `findUnique`: the scope predicate must apply. */
  async byId(accountId: string, id: string): Promise<DeniedAddressRow | null> {
    return (await this.prisma.forAccount(accountId).deniedAddress.findFirst({
      where: { id },
    })) as unknown as DeniedAddressRow | null;
  }

  /** The row a repeated add collided with — read back so the caller answers with what is stored. */
  async byAddress(accountId: string, address: string): Promise<DeniedAddressRow | null> {
    return (await this.prisma.forAccount(accountId).deniedAddress.findFirst({
      where: { address },
    })) as unknown as DeniedAddressRow | null;
  }

  /** @throws a Prisma P2002 when the address is already listed — the service reads that as success. */
  async insert(
    accountId: string,
    entry: NewDeniedAddress,
    ...alsoInTransaction: unknown[]
  ): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    await db.$transaction([
      db.deniedAddress.create({ data: toData(accountId, entry) }),
      ...alsoInTransaction,
    ] as never);
  }

  /**
   * Remove, returning how many rows actually went.
   *
   * `deleteMany` rather than `delete`: removing a row somebody else removed a second earlier must be
   * a no-op answer, not a P2025 the caller has to catch — the api-keys `revoke` precedent, and the
   * reason removal is idempotent all the way up to the wire.
   */
  async remove(accountId: string, id: string, ...alsoInTransaction: unknown[]): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [result] = (await db.$transaction([
      db.deniedAddress.deleteMany({ where: { id } }),
      ...alsoInTransaction,
    ] as never)) as unknown as [{ count: number }];
    return result?.count ?? 0;
  }

  /**
   * ⭐ The edge read: every denied address in the DEPLOYMENT, deduplicated. See the class banner for
   * why this one method carries no account context.
   *
   * ⛔ **Deliberately uncapped.** Every other batch read in this product is server-clamped; this one
   * must not be, because a truncated deny-list silently un-bans whoever fell off the end — a control
   * that reports success and stops nobody. The set is small by construction: FR-030 makes a person
   * typing an entry the only way a row comes into being.
   */
  async listAllForEdge(): Promise<string[]> {
    const rows = (await this.prisma.deniedAddress.findMany({
      select: { address: true },
      orderBy: { address: 'asc' },
    })) as unknown as Array<{ address: string }>;
    // Stored normalised, so the union is a plain set union and the edge compares without parsing.
    return [...new Set(rows.map((r) => r.address))];
  }
}
