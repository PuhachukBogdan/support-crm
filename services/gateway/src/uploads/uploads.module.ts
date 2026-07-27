import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { UploadsController } from './uploads.controller';

/**
 * Gateway uploads edge (feature 016, roadmap 4.9).
 *
 * Deliberately thin: the only judgement made in this folder is which response headers to send
 * (`serve.ts`). Validation, storage and the account check all live in `users`, because "one
 * validated path" is only checkable when validation and storage are the same component (research
 * R2). The gateway holds no `S3_*` configuration at all.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [UploadsController],
})
export class UploadsEdgeModule {}
