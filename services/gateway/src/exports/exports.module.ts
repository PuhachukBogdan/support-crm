import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { ExportsController } from './exports.controller';

/**
 * Gateway exports edge (feature 017, roadmap 4.10).
 *
 * Thin by construction, like the uploads edge it sits next to. The only judgement in this folder is
 * request parsing (`wire.ts`); ownership, readiness and expiry are decided in `chats`, and the read
 * authorization in `users`. The gateway gains no storage configuration and issues no links.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [ExportsController],
})
export class ExportsEdgeModule {}
