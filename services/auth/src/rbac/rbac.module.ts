import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CLOCK, SystemClock } from '../auth/ports/clock';
import { RbacResolverService } from './resolver.service';
import { PermissionRegistryService } from './permission-registry.service';
import { RoleDefaultsService } from './role-defaults.service';
import { OverrideService } from './override.service';
import { RoleAssignmentService } from './role-assignment.service';
import { PrivilegeAuditService } from './privilege-audit.service';
import { RbacGrpcController } from './rbac.grpc.controller';

/**
 * RBAC module (feature 011). The RBAC model is owned by the Auth service (source of truth — ADR
 * 0004/0034). US1: effective-permission resolver. US2: catalogue + role-default reads. US3:
 * management mutations (role defaults, per-user/group copy-on-write overrides, reset, role assign)
 * — each audited (PrivilegeAudit). Provides its own CLOCK (injectable — Track A determinism).
 */
@Module({
  controllers: [RbacGrpcController],
  providers: [
    PrismaService,
    { provide: CLOCK, useClass: SystemClock },
    RbacResolverService,
    PermissionRegistryService,
    RoleDefaultsService,
    OverrideService,
    RoleAssignmentService,
    PrivilegeAuditService,
  ],
})
export class RbacModule {}
