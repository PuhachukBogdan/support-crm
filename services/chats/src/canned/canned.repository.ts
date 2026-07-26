import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface CannedRow {
  id: string;
  name: string;
  body: string;
}

const CANNED_SELECT = { id: true, name: true, body: true } as const;

/**
 * Canned-response library (feature 013, US2 — roadmap 4.5). Account-scoped via `forAccount`
 * (Principle I); one shared library per account (not per-operator — spec Assumptions).
 *
 * **Text only.** This module deliberately knows nothing about conversations or messages: a canned
 * response supplies text the agent then sends through the feature-012 message path, and can never
 * send anything itself (FR-009). That is why there is no conversation id anywhere in this file.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class CannedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<CannedRow[]> {
    return (await this.prisma.forAccount(accountId).cannedResponse.findMany({
      orderBy: [{ name: 'asc' }],
      select: CANNED_SELECT,
    })) as CannedRow[];
  }

  async create(accountId: string, name: string, body: string): Promise<CannedRow> {
    return (await this.prisma.forAccount(accountId).cannedResponse.create({
      data: { account_id: accountId, name, body },
      select: CANNED_SELECT,
    })) as CannedRow;
  }
}
