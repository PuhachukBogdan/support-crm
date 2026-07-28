import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { MaintenanceService } from './maintenance.service';

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
  constructor(@Inject(MaintenanceService) private readonly maintenance: MaintenanceService) {}

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
}
