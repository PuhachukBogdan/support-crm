import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { RbacResolverService } from '../rbac/resolver.service';
import { GroupService } from './group.service';
import { GroupGrpcController } from './group.grpc.controller';

/**
 * Group module (feature 024, roadmap 5.3 — ADR 0039).
 *
 * It depends on `RbacResolverService` and not the other way round, which is the dependency direction
 * that keeps ADR 0039 §2 true: the resolver reads group grants straight out of `auth_db` as one more
 * term, and knows nothing about this module. If the arrow ever points the other way — a group asking
 * the resolver what it may confer — that is the second policy layer appearing.
 */
@Module({
  controllers: [GroupGrpcController],
  providers: [PrismaService, AuditRepository, RbacResolverService, GroupService],
  exports: [GroupService],
})
export class GroupModule {}
