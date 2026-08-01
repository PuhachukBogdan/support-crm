import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PresenceController } from './presence.grpc.controller';
import { PresenceReadController } from './presence.read.controller';
import { PresenceRepository } from './presence.repository';
import { PresenceService } from './presence.service';
import { LabelsRepository } from './labels.repository';
import { OperatorTransitionRecorder } from '../transition/transition.recorder';

/**
 * Presence (feature 025, roadmap 5.9).
 *
 * ⚠️ A module nobody imports contributes no handlers, and the service then answers UNIMPLEMENTED
 * while looking perfectly healthy. That is not hypothetical: it is feature 015's single Track-B
 * failure, and `services/users/src/maintenance/hosting.spec.ts` asserts this module is in the app
 * graph rather than reasoning that it must be.
 */
@Module({
  controllers: [PresenceController, PresenceReadController],
  providers: [
    PrismaService,
    PresenceRepository,
    PresenceService,
    LabelsRepository,
    OperatorTransitionRecorder,
  ],
  exports: [PresenceRepository, PresenceService],
})
export class PresenceModule {}
