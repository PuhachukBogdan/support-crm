import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { MaintenanceService } from './maintenance.service';
import { PresenceSweepService } from '../presence/presence-sweep.service';
import { loadUsersConfig } from '../config';

interface BatchWire {
  limit?: number;
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * `UsersMaintenanceService` — the only way to reach the one byte-removing path (feature 017, US3).
 *
 * Three properties, and all three are needed for the narrowing of feature 016's "nothing removes bytes"
 * to be a narrowing rather than a hole:
 *
 *   • **System actor only.** A user session must never reach a cross-account path, even a counts-only
 *     one — feature 014's rule for the SLA sweep, applied to something with teeth.
 *   • **No gateway route.** `tests/exports/no-presign.spec.ts` and the route scan assert that nothing in
 *     the gateway maps to a maintenance RPC, so "system actor only" cannot be reached by asking nicely
 *     over HTTP.
 *   • **Counts only in the response.** The caller is a scheduler; ids and keys would be data it has no
 *     use for and a log line waiting to happen.
 *
 * It is a SEPARATE gRPC service from `UploadsService`, deliberately. Putting a purge verb on the
 * requester-facing surface is how "there is no DeleteUpload" quietly stops being true.
 *
 * ⚠️ The handler carries no permission decorator and that is not an omission: there is no permission
 * that grants deletion, because no ROLE may reach this at all. The check is the actor KIND, which no
 * amount of permission breadth satisfies — the same reasoning that keeps the audit trail append-only
 * for the owner.
 */
@Controller()
export class MaintenanceController {
  constructor(
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    // Feature 025 (roadmap 5.9): the auto-away sweep. Same three properties as the purge above —
    // system actor only, no gateway route, counts in the response — which is why it lives here and
    // not on the presence service.
    @Inject(PresenceSweepService) private readonly sweep: PresenceSweepService,
  ) {}

  @GrpcMethod('UsersMaintenanceService', 'PurgeExpiredArtefacts')
  async purgeExpiredArtefacts(req: BatchWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    // The service clamps the batch; passing the raw value through keeps the ceiling in one place.
    const counts = await this.maintenance.purgeExpiredArtefacts(Number(req?.limit ?? 0), new Date());
    return {
      purged: counts.purged,
      objectMissing: counts.objectMissing,
      failed: counts.failed,
    };
  }

  /**
   * Lower the availability of operators whose session has gone quiet (feature 025, roadmap 5.9).
   *
   * Here rather than on `OperatorPresenceService`, and for the three properties that make this
   * service what it is. The middle one is the security argument: a sweep reachable from a session
   * would be a way to put a colleague offline without holding `users.presence.manage`, which is the
   * key that governs exactly that.
   */
  @GrpcMethod('UsersMaintenanceService', 'SweepIdlePresence')
  async sweepIdlePresence(req: BatchWire, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const cfg = loadUsersConfig();
    const counts = await this.sweep.sweepIdle(Number(req?.limit ?? 0), new Date(), {
      awayAfterSeconds: cfg.PRESENCE_AWAY_AFTER_SECONDS,
      offlineAfterSeconds: cfg.PRESENCE_OFFLINE_AFTER_SECONDS,
    });
    return { toAway: counts.toAway, toOffline: counts.toOffline, failed: counts.failed };
  }
}
