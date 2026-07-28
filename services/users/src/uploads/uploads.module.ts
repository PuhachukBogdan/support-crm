import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  OBJECT_STORE,
  S3ObjectStore,
  objectStoreConfigFromEnv,
  type ObjectStoreConfig,
} from './object-store';
import { UploadsRepository } from './uploads.repository';
import { ArtefactPurgeRepository } from './artefact-purge.repository';
import { UploadsGrpcController } from './uploads.grpc.controller';

/**
 * The uploads surface (feature 016, roadmap 4.9).
 *
 * Everything that touches bytes or storage credentials is wired here and nowhere else — that
 * concentration IS the SEC-1 fix, and `tests/uploads/single-ingest-path.spec.ts` fails the build if
 * it starts leaking outward.
 *
 * Config is read from `process.env` in the factory, following the convention set in Phase 1: values
 * are validated refuse-to-start by `loadUsersConfig()` in `main.ts` BEFORE Nest instantiates
 * anything, so by the time this runs the keys are known to be present and non-placeholder (SEC-6).
 * Reading them here rather than threading a config object keeps the credential's blast radius to
 * one provider.
 */
@Module({
  controllers: [UploadsGrpcController],
  providers: [
    PrismaService,
    { provide: 'OBJECT_STORE_CONFIG', useFactory: (): ObjectStoreConfig => objectStoreConfigFromEnv() },
    { provide: OBJECT_STORE, useClass: S3ObjectStore },
    UploadsRepository,
    // Feature 017 (US3): the one byte-removing path. Provided HERE, beside the credentials it needs,
    // and exported so the maintenance surface can reach it without holding a store client of its own.
    ArtefactPurgeRepository,
  ],
  exports: [UploadsRepository, ArtefactPurgeRepository],
})
export class UploadsModule {}
