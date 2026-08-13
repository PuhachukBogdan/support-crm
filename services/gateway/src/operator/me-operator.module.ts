import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { MeOperatorController } from './me-operator.controller';

/**
 * Gateway edge for the caller's own operator identity (roadmap 5.11, MVP block W5).
 *
 * One GET, no judgement: the translation auth-identity → operator-profile lives in `users`
 * (`OperatorProfileService`), and this module only puts it on a path an ordinary agent may call.
 * Reuses the existing users client rather than registering a second one.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [MeOperatorController],
})
export class MeOperatorModule {}
