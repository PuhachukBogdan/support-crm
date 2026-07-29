import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UiPreferencesRepository } from './ui-preferences.repository';
import { UiPreferencesController } from './ui-preferences.grpc.controller';

/**
 * The operator UI-preference surface (feature 021, roadmap 5.6).
 *
 * ⚠️ Its own module, and its own folder, on purpose. These are an EMPLOYEE's appearance settings —
 * cosmetic, self-owned, gated by no permission and written to no audit trail. Every neighbouring
 * surface in this service is the opposite on all four counts. Putting them side by side is how one
 * inherits the other's treatment by proximity, which is exactly what feature 018 warned about when
 * it gave the operator read path a folder of its own.
 *
 * Registering the controller here — and importing this module from `AppModule` — is what makes the
 * RPCs actually SERVED. Feature 015's single live-only defect was a hosted package whose handler was
 * never wired: the service was up, healthy, and answered `UNIMPLEMENTED`. `hosting.spec.ts` asserts
 * both links rather than trusting this comment.
 */
@Module({
  controllers: [UiPreferencesController],
  providers: [PrismaService, UiPreferencesRepository],
  exports: [UiPreferencesRepository],
})
export class UiPreferencesModule {}
