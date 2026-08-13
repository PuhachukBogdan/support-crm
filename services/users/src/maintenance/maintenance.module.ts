import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { PresenceModule } from '../presence/presence.module';
import { PresenceSweepService } from '../presence/presence-sweep.service';
import { PrismaService } from '../prisma.service';
import { OperatorRepository } from '../operator/operator.repository';
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
  imports: [UploadsModule, PresenceModule],
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
    ChannelParticipantService,
    // ⚠️ A value provider, so a deployment with no salt fails to CONSTRUCT rather than resolving nobody
    // for ever. `loadUsersConfig` already refuses a salt shorter than 32 characters; this is where that
    // refusal becomes the service's own boot condition — see the token's own note.
    { provide: CONTACT_HASH_SALT, useFactory: () => loadUsersConfig().CONTACT_HASH_SALT },
  ],
})
export class MaintenanceModule {}
