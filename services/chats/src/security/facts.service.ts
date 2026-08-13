import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  CHATS_SECURITY_FACTS,
  type ChatsFactContext,
  type SecurityFactEntry,
} from './facts.registry';

/** The wire shape (`crm.security.v1.SecurityFact`). Every member is a string — proto3, no optionals. */
export interface SecurityFactWire {
  key: string;
  label: string;
  severity: string;
  kind: string;
  state: string;
  value: string;
  note: string;
}

/**
 * ⭐ W32 / 039 — runs {@link CHATS_SECURITY_FACTS} for one account and answers the wire shape.
 *
 * ⚠️ **A read that throws becomes `unknown` — never `ok`, and never silence** (FR-020). A chats
 * database that stopped answering must show up as facts nobody could establish; a page that quietly
 * drops them looks identical to a page where everything is fine, which is the failure this screen
 * exists to prevent.
 *
 * ⓘ The resolution loop is duplicated in `services/auth/src/security/facts.service.ts` rather than
 * shared, for the reason `actor-context.ts` already records: `libs/common` carries no NestJS
 * dependency, and each service owns its own registry type. Twenty lines twice is cheaper than a
 * shared module that would have to know both services' Prisma clients.
 */
@Injectable()
export class SecurityFactsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string): Promise<SecurityFactWire[]> {
    return resolveFacts(CHATS_SECURITY_FACTS, { db: this.prisma.forAccount(accountId) });
  }
}

/** Resolve every entry against one context. Exported for the unit test, which drives it with a fake. */
export async function resolveFacts(
  entries: readonly SecurityFactEntry[],
  ctx: ChatsFactContext,
): Promise<SecurityFactWire[]> {
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind === 'built_in' || !entry.read) {
        return toWire(entry, { state: 'ok', value: entry.value ?? '', note: entry.note });
      }
      try {
        const reading = await entry.read(ctx);
        if (reading === null) return null;
        return toWire(entry, reading);
      } catch {
        return toWire(entry, {
          state: 'unknown',
          value: 'неизвестно',
          note: 'Не удалось прочитать — считайте, что состояние не проверено.',
        });
      }
    }),
  );
  return resolved.filter((f): f is SecurityFactWire => f !== null);
}

function toWire(
  entry: SecurityFactEntry,
  reading: { state: string; value: string; note?: string },
): SecurityFactWire {
  return {
    key: entry.key,
    label: entry.label,
    severity: entry.severity,
    kind: entry.kind,
    state: reading.state,
    value: reading.value,
    note: reading.note ?? entry.note ?? '',
  };
}
