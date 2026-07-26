import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface LabelRow {
  id: string;
  name: string;
  color: string | null;
}

const LABEL_SELECT = { id: true, name: true, color: true } as const;

/**
 * Label read/write path (feature 013, US2 — roadmap 4.5). Account-scoped via `forAccount`
 * (Principle I). Labels are **managed** entities: attaching uses a label that already exists in the
 * account (create-then-attach); nothing is created implicitly on attach.
 *
 * Idempotency (spec Edge Case / SC-006): attach is an `upsert` on the composite key and detach is a
 * `deleteMany`, so attaching twice or detaching an absent link are both safe no-ops rather than
 * errors. `ConversationLabel` carries no `account_id` — it is scoped through its parents, which is
 * why the caller must resource-check the conversation first.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class LabelsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<LabelRow[]> {
    return (await this.prisma.forAccount(accountId).label.findMany({
      orderBy: [{ name: 'asc' }],
      select: LABEL_SELECT,
    })) as LabelRow[];
  }

  async create(accountId: string, name: string, color: string | null): Promise<LabelRow> {
    return (await this.prisma.forAccount(accountId).label.create({
      // account_id is injected by the scoped client too; set explicitly so the create type is met.
      data: { account_id: accountId, name, color },
      select: LABEL_SELECT,
    })) as LabelRow;
  }

  /** Labels attached to one conversation. The conversation must already be access-checked. */
  async listForConversation(accountId: string, conversationId: string): Promise<LabelRow[]> {
    const links = (await this.prisma.forAccount(accountId).conversationLabel.findMany({
      where: { conversation_id: conversationId },
      select: { label: { select: LABEL_SELECT } },
    })) as { label: LabelRow }[];
    return links.map((l) => l.label).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** True when the label exists in this account (guards against attaching a foreign label). */
  async exists(accountId: string, labelId: string): Promise<boolean> {
    const row = await this.prisma.forAccount(accountId).label.findFirst({
      where: { id: labelId },
      select: { id: true },
    });
    return row !== null;
  }

  /** Idempotent attach — attaching an already-attached label changes nothing (SC-006). */
  async attach(accountId: string, conversationId: string, labelId: string): Promise<void> {
    await this.prisma.forAccount(accountId).conversationLabel.upsert({
      where: {
        conversation_id_label_id: { conversation_id: conversationId, label_id: labelId },
      },
      create: { conversation_id: conversationId, label_id: labelId },
      update: {},
    });
  }

  /** Idempotent detach — detaching an absent link is a no-op (SC-006). */
  async detach(accountId: string, conversationId: string, labelId: string): Promise<void> {
    await this.prisma.forAccount(accountId).conversationLabel.deleteMany({
      where: { conversation_id: conversationId, label_id: labelId },
    });
  }
}
