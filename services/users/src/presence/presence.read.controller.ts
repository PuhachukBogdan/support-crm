import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import type { PresenceState } from '@crm/common';
import { PresenceRepository } from './presence.repository';
import { PresenceService } from './presence.service';

/**
 * The presence READS, on `UsersReadService` (feature 025, roadmap 5.9).
 *
 * A second controller for an existing gRPC service is the established shape here —
 * `AuditReadController` already serves `UsersReadService.ListAuditEntries` beside the player
 * handlers. Splitting by subject keeps each controller readable; NestJS composes the handlers.
 *
 * ── Who may read whom ───────────────────────────────────────────────────────────────────────────
 *   • **Your own presence** — always. No key: it is a fact about yourself.
 *   • **Somebody else's** — `users.list.view`, reused deliberately rather than inventing a second
 *     read key. It is the same fact class (who works here, and at the coarsest level what they are
 *     doing right now), and a `users.presence.view` would be a key nobody thinks to grant, making
 *     the desk view mysteriously empty for the people who need it. Effect: team leads and above see
 *     the desk; line agents see themselves.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const may = (md: Metadata | undefined, key: string): boolean =>
  readStr(md, 'x-actor-permissions')
    .split(',')
    .map((s) => s.trim())
    .includes(key);

const STATE_WIRE: Readonly<Record<PresenceState, number>> = {
  online: 1,
  transfers_only: 2,
  away: 3,
  offline: 4,
};
const CAUSE_WIRE: Readonly<Record<string, number>> = { manual: 1, auto_inactivity: 2, admin: 3 };

interface GetWire {
  authUserId?: string;
  auth_user_id?: string;
}
interface ListWire {
  authUserIds?: string[];
  auth_user_ids?: string[];
}

@Controller()
export class PresenceReadController {
  constructor(
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(PresenceRepository) private readonly repo: PresenceRepository,
  ) {}

  @GrpcMethod('UsersReadService', 'GetOperatorPresence')
  async getOperatorPresence(req: GetWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const caller = readStr(metadata, 'x-actor-user-id');
    const subject = req?.authUserId ?? req?.auth_user_id ?? '';
    const target = subject || caller;
    if (!accountId || !target) return {};

    // Reading somebody else needs the staff-list key. Refused as "not found" rather than
    // "forbidden": on a read, distinguishing the two turns the endpoint into a directory of who
    // works here for a caller who may not see the staff list at all.
    if (target !== caller && !may(metadata, 'users.list.view')) return {};

    const outcome = await this.presence.read(accountId, target);
    if (outcome.status !== 'ok') return {};

    const blocked = (await this.repo.blockedChannels(accountId, [target])).get(target) ?? [];
    const operator = await this.repo.operatorFor(accountId, target);
    return this.wire(outcome.presence, blocked, operator?.active ?? false);
  }

  @GrpcMethod('UsersReadService', 'ListOperatorPresence')
  async listOperatorPresence(req: ListWire, metadata: Metadata) {
    const accountId = readStr(metadata, 'x-actor-account-id');
    const caller = readStr(metadata, 'x-actor-user-id');
    const ids = req?.authUserIds ?? req?.auth_user_ids ?? [];
    if (!accountId || ids.length === 0) return { presence: [] };

    // A list of other people is the staff-list question by definition. A caller without the key may
    // still ask about themselves — asking for a list containing only yourself is not a directory.
    const requested = may(metadata, 'users.list.view') ? ids : ids.filter((id) => id === caller);
    if (requested.length === 0) return { presence: [] };

    // Three reads for the whole set, never per person (Principle VII) — this is the shape the desk
    // view and the routing pool both need.
    const [rows, blocks] = await Promise.all([
      this.repo.readMany(accountId, requested),
      this.repo.blockedChannels(accountId, requested),
    ]);

    const out = [];
    for (const id of requested) {
      const operator = await this.repo.operatorFor(accountId, id);
      // ⚠️ ABSENT, not offline: somebody with no operator profile is not a member of staff, and
      // reporting them as offline would be a claim about a person the product does not employ.
      if (!operator) continue;
      const row = rows.get(id) ?? {
        auth_user_id: id,
        state: 'offline',
        last_cause: null,
        last_seen_at: null,
        label_id: null,
      };
      out.push(this.wire(row, blocks.get(id) ?? [], operator.active));
    }
    return { presence: out };
  }

  private wire(
    row: { auth_user_id: string; state: string; last_cause: string | null; last_seen_at: Date | null; label_id: string | null },
    blockedChannels: string[],
    operatorActive: boolean,
  ) {
    return {
      authUserId: row.auth_user_id,
      state: STATE_WIRE[row.state as PresenceState] ?? 0,
      lastCause: row.last_cause ? (CAUSE_WIRE[row.last_cause] ?? 0) : 0,
      lastSeenAt: row.last_seen_at?.toISOString() ?? '',
      labelId: row.label_id ?? '',
      blockedChannels,
      operatorActive,
    };
  }
}
