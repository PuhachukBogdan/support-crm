import { Controller, Get, Inject, OnModuleInit, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from './requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { AUTH_CLIENT, CHATS_CLIENT } from '../grpc/clients.module';

/**
 * ⭐ W32 (roadmap 12.11) — the security-posture page's data, federated from the services that own it.
 *
 * ── Why the facts are not assembled here ────────────────────────────────────────────────────────
 * The gateway holds no database. Every fact belongs to the service that owns the data behind it, and
 * a fact living away from its data is a fact that drifts from it — the exact way a posture page
 * becomes a lie. So this concatenates and decides nothing, the same shape the audit read already
 * federates in production one folder over.
 *
 * ── ⚠️ AN UNREACHABLE SERVICE IS `unknown`, NEVER SILENCE AND NEVER `ok` ────────────────────────
 * If chats cannot answer, its facts must still appear, marked unknown. Dropping them would make a
 * partial outage look like a shorter checklist — every remaining row green, nothing to notice. And
 * defaulting to `ok` would be worse: an administrator reads «healthy» about a control nobody could
 * verify. This is the single most important behaviour on this surface, which is why it is here rather
 * than left to each service to remember.
 */

interface SecurityFactWire {
  key?: string;
  label?: string;
  severity?: string;
  kind?: string;
  state?: string;
  value?: string;
  note?: string;
}

interface FactsGrpc {
  listSecurityFacts(d: Record<string, never>, md: unknown): Observable<{ facts?: SecurityFactWire[] }>;
}

type AdminReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

const PERMISSION = 'platform.settings.manage';

/** What one source contributes when it cannot be reached. Named so its shape cannot drift. */
const unavailable = (source: string): SecurityFactWire => ({
  key: `${source}.unavailable`,
  label: `Не удалось прочитать состояние: ${source}`,
  severity: 'critical',
  kind: 'read',
  state: 'unknown',
  value: 'неизвестно',
  note: 'Служба не ответила. Это НЕ значит, что защита в порядке — значит, что её не удалось проверить.',
});

@Controller('admin/security')
export class SecurityFactsController implements OnModuleInit {
  private auth!: FactsGrpc;
  private chats!: FactsGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly authClient: ClientGrpc,
    @Inject(CHATS_CLIENT) private readonly chatsClient: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.auth = this.authClient.getService<FactsGrpc>('AuthService');
    this.chats = this.chatsClient.getService<FactsGrpc>('ChatsReadService');
  }

  @Get()
  @RequiresPermission(PERMISSION)
  async facts(@Req() req: AdminReq) {
    const md = buildActorMetadata(req.claims as RequestClaims, req.effective);

    // Asked in parallel: one slow source must not decide how long an administrator waits for the
    // page. `allSettled`, because a rejection here is an ANSWER (`unknown`), not a failure of the read.
    const [authFacts, chatsFacts] = await Promise.allSettled([
      firstValueFrom(this.auth.listSecurityFacts({}, md)),
      firstValueFrom(this.chats.listSecurityFacts({}, md)),
    ]);

    const facts: SecurityFactWire[] = [
      ...(authFacts.status === 'fulfilled' ? (authFacts.value.facts ?? []) : [unavailable('auth')]),
      ...(chatsFacts.status === 'fulfilled' ? (chatsFacts.value.facts ?? []) : [unavailable('chats')]),
    ];

    // ⓘ `generatedAt` and nothing cached. A stored posture is a posture that can be stale, and a
    // stale security page reports yesterday's protections with today's confidence.
    return { facts, generatedAt: new Date().toISOString() };
  }
}
