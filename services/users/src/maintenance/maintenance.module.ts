import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { PresenceModule } from '../presence/presence.module';
import { PresenceSweepService } from '../presence/presence-sweep.service';
import { PrismaService } from '../prisma.service';
import { OperatorRepository } from '../operator/operator.repository';
import { StaffLifecycleRepository } from './staff-lifecycle.repository';
import {
  ChannelParticipantService,
  CONTACT_HASH_SALT,
} from '../channel/channel-participant.service';
import { loadUsersConfig } from '../config';

/**
 * The maintenance surface (feature 017, US3).
 *
 * It imports `UploadsModule` rather than providing the object store itself — that is the whole point.
 * Storage credentials stay wired in exactly one module, and this one depends on the repository that
 * module exports. A maintenance module that constructed its own `S3ObjectStore` would be a second
 * credential holder, which `tests/uploads/single-ingest-path.spec.ts` exists to prevent.
 */
@Module({
  // ⭐ W32: imports rather than re-provides, for the same reason UploadsModule is imported — one
  // writer for «who looks after this player», reached by two surfaces with two different gates.
  imports: [UploadsModule, PresenceModule, AssignmentModule],
  controllers: [MaintenanceController],
  // Feature 031: `ResolveRoutingOperators` answers the routing question for a MACHINE, from the same
  // repository the permission-gated human rpc uses. One method, two surfaces, two different gates.
  // Feature 033: `ResolveChannelParticipant` — the reply envelope, owned by the service that owns
  // contact values (research R9).
  providers: [
    MaintenanceService,
    PresenceSweepService,
    PrismaService,
    OperatorRepository,
    // ⭐ W31 / feature 038: the `Operator.active` writer. Its own class, beside the purge, because the
    // read repositories are pinned write-free by FR-027 and that guard is worth keeping true.
    StaffLifecycleRepository,
    ChannelParticipantService,
    // ⚠️ A value provider, so a deployment with no salt fails to CONSTRUCT rather than resolving nobody
    // for ever. `loadUsersConfig` already refuses a salt shorter than 32 characters; this is where that
    // refusal becomes the service's own boot condition — see the token's own note.
    { provide: CONTACT_HASH_SALT, useFactory: () => loadUsersConfig().CONTACT_HASH_SALT },
  ],
})
export class MaintenanceModule {}
