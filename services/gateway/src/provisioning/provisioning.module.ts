import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { ProvisioningController } from './provisioning.controller';
import { AdminApiKeysController } from './api-keys.controller';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15 + 3.17) — the two halves of the machine boundary.
 *
 * They share a folder because they share a subject and nothing else: one is the door another
 * company's system knocks on, the other is where our administrators cut the keys to it. That the
 * first is `@Public()` and the second is permission-gated is the most important fact about this
 * module, which is why they sit side by side where a reader will see both at once.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [ProvisioningController, AdminApiKeysController],
})
export class ProvisioningEdgeModule {}
