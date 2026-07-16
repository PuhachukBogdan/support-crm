import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  OnModuleInit,
  Query,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable, timeout } from 'rxjs';
import type { PingRequest, PingResponse } from '@crm/proto';
import { PING_CLIENT } from '../grpc/clients.module';

interface PingServiceClient {
  ping(request: PingRequest): Observable<PingResponse>;
}

const DOWNSTREAM_TIMEOUT_MS = 2000;

/**
 * REST → gRPC round-trip (spec 003, US3 / FR-007, FR-008). `GET /ping` forwards to the
 * users service over gRPC and returns the DOWNSTREAM response. If users is unavailable, it
 * returns a clear 503 (never crashes). Bounded by a deadline so it can't hang.
 */
@Controller('ping')
export class PingController implements OnModuleInit {
  private pingService!: PingServiceClient;

  constructor(@Inject(PING_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.pingService = this.client.getService<PingServiceClient>('PingService');
  }

  @Get()
  async ping(@Query('message') message = 'ping'): Promise<{
    message: string;
    servedAt: string;
    servedBy: 'users';
  }> {
    try {
      const res = await firstValueFrom(
        this.pingService.ping({ message }).pipe(timeout(DOWNSTREAM_TIMEOUT_MS)),
      );
      return { message: res.message, servedAt: res.servedAt, servedBy: 'users' };
    } catch {
      throw new HttpException(
        { status: 'degraded', error: "downstream service 'users' unavailable", service: 'users' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
