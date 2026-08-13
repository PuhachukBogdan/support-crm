import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * W14 (roadmap 3.8) — the account's people, for the admin screen.
 *
 * ⚠️ **Staff facts only.** `auth` holds no customer data at all, so nothing here needs the masking
 * apparatus the player reads carry — and conflating the two vocabularies is exactly how a staff
 * screen grows a customer field. What a person may see about ANOTHER PERSON is a different question
 * from what they may see about a customer, and this repository answers only the first.
 *
 * Keyset, like every list in this product: ordered by `(email, id)` because a directory of people is
 * read alphabetically, and an offset over a table somebody is inviting into skips rows.
 */
export interface StaffRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roleKey: string;
}

/** `email|id`, base64url — opaque to the caller, and re-derived from the last row of each page. */
function encode(email: string, id: string): string {
  return Buffer.from(JSON.stringify([email, id]), 'utf8').toString('base64url');
}
function decode(token: string): { email: string; id: string } | null {
  try {
    const [email, id] = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as [string, string];
    if (typeof email !== 'string' || typeof id !== 'string') return null;
    return { email, id };
  } catch {
    return null;
  }
}

/** Thrown for a token this repository did not mint. The caller maps it to INVALID_ARGUMENT. */
export class InvalidStaffCursor extends Error {}

@Injectable()
export class StaffRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    accountId: string,
    limit: number,
    pageToken?: string,
  ): Promise<{ rows: StaffRow[]; nextPageToken: string }> {
    const cursor = pageToken ? decode(pageToken) : null;
    if (pageToken && !cursor) throw new InvalidStaffCursor('invalid page token');

    const where: Record<string, unknown> = { account_id: accountId };
    if (cursor) {
      where.OR = [
        { email: { gt: cursor.email } },
        { AND: [{ email: cursor.email }, { id: { gt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ email: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true,
        email: true,
        display_name: true,
        status: true,
        // One role per person: assigning replaces, so `take: 1` is the shape, not a truncation.
        roles: { select: { role: { select: { key: true } } }, take: 1 },
      },
    });

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];

    return {
      rows: kept.map((u) => ({
        id: u.id,
        email: u.email,
        // Absent stays absent as an empty string on the wire; the screen shows the email instead of
        // inventing a name from it.
        displayName: u.display_name ?? '',
        status: u.status,
        roleKey: u.roles[0]?.role.key ?? '',
      })),
      nextPageToken: hasMore && last ? encode(last.email, last.id) : '',
    };
  }
}
