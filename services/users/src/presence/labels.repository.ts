import { Inject, Injectable } from '@nestjs/common';
import type { PresenceState } from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * The administrator-editable label set (feature 025, roadmap 5.9 — US5).
 *
 * ⚠️ **Routing never reads any of this.** A label is a word displayed beside a state; the state is
 * what routing asks about. `tests/contracts/presence-label-never-branched-on.spec.ts` asserts that no
 * code anywhere branches on a label's name — the same guard eight closed catalogues in this product
 * already carry, applied here to a thing that is deliberately NOT a catalogue.
 *
 * A table rather than a catalogue for two reasons pointing the same way: ADR 0042 §7 requires
 * administrators to edit the set, which a compile-time catalogue cannot allow; and every closed
 * catalogue here is closed because a new member CHANGES BEHAVIOUR, while a new label must change
 * none.
 */

export interface LabelRow {
  id: string;
  name: string;
  state: string;
}

export type UpsertResult =
  | { status: 'ok'; label: LabelRow }
  | { status: 'name_taken' }
  | { status: 'unknown_label' };

/** Prisma's unique-violation code — the collision is caught by the DATABASE, never by a pre-read. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

@Injectable()
export class LabelsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<LabelRow[]> {
    return (await this.prisma.forAccount(accountId).presenceLabel.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, state: true },
    })) as LabelRow[];
  }

  async exists(accountId: string, id: string): Promise<boolean> {
    const row = await this.prisma.forAccount(accountId).presenceLabel.findFirst({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  }

  async upsert(
    accountId: string,
    id: string,
    name: string,
    state: PresenceState,
  ): Promise<UpsertResult> {
    const db = this.prisma.forAccount(accountId);
    try {
      if (id) {
        const existing = await db.presenceLabel.findFirst({ where: { id }, select: { id: true } });
        if (!existing) return { status: 'unknown_label' };
        const updated = (await db.presenceLabel.update({
          where: { id },
          data: { name, state },
          select: { id: true, name: true, state: true },
        })) as LabelRow;
        return { status: 'ok', label: updated };
      }
      const created = (await db.presenceLabel.create({
        data: { account_id: accountId, name, state },
        select: { id: true, name: true, state: true },
      })) as LabelRow;
      return { status: 'ok', label: created };
    } catch (err) {
      // Caught rather than pre-checked: a read-then-write leaves a window in which two administrators
      // both see the name free. The unique index is the only thing that cannot be raced.
      if (isUniqueViolation(err)) return { status: 'name_taken' };
      throw err;
    }
  }

  /**
   * Remove a label.
   *
   * ⚠️ Clears the reference from everyone displaying it and leaves their presence STATE untouched
   * (FR-028). This is why `OperatorPresence.label_id` is a soft reference and not a foreign key with
   * a cascade: deleting a decoration must never change who receives work, and a cascade would make
   * that a property of a database setting rather than a decision.
   */
  async remove(accountId: string, id: string): Promise<boolean> {
    const db = this.prisma.forAccount(accountId);
    const existing = await db.presenceLabel.findFirst({ where: { id }, select: { id: true } });
    if (!existing) return false;

    await db.$transaction(async (tx) => {
      const client = tx as unknown as {
        operatorPresence: { updateMany(args: Record<string, unknown>): Promise<unknown> };
        presenceLabel: { delete(args: Record<string, unknown>): Promise<unknown> };
      };
      await client.operatorPresence.updateMany({
        where: { account_id: accountId, label_id: id },
        data: { label_id: null },
      });
      await client.presenceLabel.delete({ where: { id } });
    });
    return true;
  }
}
