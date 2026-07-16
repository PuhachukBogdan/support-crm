import { Module } from '@nestjs/common';
import { PingController } from './ping.controller';
import { GrpcClientsModule } from '../grpc/clients.module';

// REST → gRPC ping round-trip to the users service (spec 003, US3).
@Module({
  imports: [GrpcClientsModule],
  controllers: [PingController],
})
export class PingModule {}
