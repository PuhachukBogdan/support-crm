import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import {
  AUTH_SECURITY_FACTS,
  type AuthFactContext,
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
 * ⭐ W32 / 039 — runs {@link AUTH_SECURITY_FACTS} for one account and answers the wire shape.
 *
 * ── The whole of the resolution rule, and why it is here rather than in the registry ────────────
 * The registry is a DECLARATION and stays one: the structural guard reads it as text, and a file
 * that also contains machinery gives the scanner more to be wrong about. This file is the machinery.
 *
 * ⚠️ **A read that throws becomes `unknown` — never `ok`, and never silence** (FR-020). The three
 * outcomes are distinct on purpose:
 *   • the reader answers  ⇒ its own state;
 *   • the reader throws   ⇒ `unknown`, still shown, so a database that stopped answering is visible
 *                           as a fact nobody could establish rather than as a page that looks fine;
 *   • the reader returns `null` ⇒ omitted, and ONLY for a fact whose existence is conditional (the
 *                           fixed sign-in code). This is the one case where absence is the answer,
 *                           and it is a property of the deployment, not of the query.
 *
 * ⛔ Nothing here logs. There is no logger in this module, so there is no line for a fact's value to
 * be interpolated into later — the same reasoning as the API-key module (SEC-PV1).
 */
@Injectable()
export class SecurityFactsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async list(accountId: string): Promise<SecurityFactWire[]> {
    const ctx: AuthFactContext = { db: this.prisma.forAccount(accountId), config: this.config };
    return resolveFacts(AUTH_SECURITY_FACTS, ctx);
  }
}

/**
 * Resolve every entry against one context. Exported for the unit test, which drives it with a fake
 * client — the assertion that matters (no address on the page) is about the OUTPUT of this function.
 */
export async function resolveFacts(
  entries: readonly SecurityFactEntry[],
  ctx: AuthFactContext,
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
        // ⚠️ The error itself is deliberately not carried anywhere: it can hold a query, and a query
        // here holds addresses (the fixed-code reader passes them to `count`). «Неизвестно» is the
        // whole of what an administrator needs — the cause belongs in the service's own logs.
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
