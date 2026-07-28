import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

/**
 * The maintenance surface (feature 017, US3).
 *
 * It imports `UploadsModule` rather than providing the object store itself — that is the whole point.
 * Storage credentials stay wired in exactly one module, and this one depends on the repository that
 * module exports. A maintenance module that constructed its own `S3ObjectStore` would be a second
 * credential holder, which `tests/uploads/single-ingest-path.spec.ts` exists to prevent.
 */
@Module({
  imports: [UploadsModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
