import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { SecurityModule } from '../security/security.module';
import { AssignmentController } from './assignment.controller';

/**
 * Player assignment edge module (feature 026, roadmap 5.7).
 *
 * `SecurityModule` for the permission guard — NOT for a cache. An attachment decides what a person
 * may READ, so a stale answer is an access-control defect rather than a freshness one.
 */
@Module({
  imports: [GrpcClientsModule, SecurityModule],
  controllers: [AssignmentController],
})
export class AssignmentEdgeModule {}
