import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { AuditController } from './audit.controller';
import { AuditFederation } from './audit.federation';

/**
 * The audit read surface (feature 015, roadmap 4.8). One REST route over a federated read: the trail lives in
 * three databases because each entry must sit in the transaction of the action it describes (spec Q3), and the
 * reader is owed one ordered log regardless.
 *
 * Composition is a legitimate gateway job — it is business LOGIC the gateway may not hold (Principle VIII),
 * and merging three sorted streams is presentation. There is no write path here at all.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [AuditController],
  providers: [AuditFederation],
})
export class AuditModule {}
