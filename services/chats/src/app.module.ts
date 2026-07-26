import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';
import { ChatsAccessGuard } from './security/permission.guard';
import { ConversationRepository } from './conversation/conversation.repository';
import { ConversationReadController } from './conversation/conversation.grpc.controller';
import { ConversationWriteController } from './conversation/conversation.write.controller';
import { MessageRepository } from './message/message.repository';
import { MessageReadController, MessageWriteController } from './message/message.grpc.controller';
import { FeedReadController } from './feed/feed.grpc.controller';
import { AssignmentRepository } from './assignment/assignment.repository';
import { AssignmentWriteController } from './assignment/assignment.grpc.controller';
import { LabelsRepository } from './labels/labels.repository';
import { LabelsController } from './labels/labels.grpc.controller';
import { MacrosRepository } from './macros/macros.repository';
import { MacrosController } from './macros/macros.grpc.controller';
import { CannedRepository } from './canned/canned.repository';
import { CannedController } from './canned/canned.grpc.controller';
import { RoundRobinStateRepository } from './assignment/round-robin-state.repository';
import { AutoAssignController } from './assignment/auto-assign.grpc.controller';
// Feature 014 (roadmap 4.6/4.7): automations + first-reply SLA.
import { ChatsAuthModule } from './auth/auth.client';
import { DomainEventDispatcher } from './events/events.dispatcher';
import { DomainEventPublisher } from './events/events.publisher';
import { AutomationsRepository } from './automation/automations.repository';
import { AutomationEngine } from './automation/engine';
import { AutomationsController } from './automation/automations.grpc.controller';
import { SlaRepository } from './sla/sla.repository';
import { SlaSweepRepository } from './sla/sla-sweep.repository';
import { FirstReplyClock } from './sla/first-reply.clock';
import { SlaController, SlaMaintenanceController } from './sla/sla.grpc.controller';

// Phase 1 (spec 003): health probe. Feature 012 (roadmap 4.1–4.3): the chats-core domain —
// ChatsReadService / ChatsWriteService over chats_db, account-scoped (forAccount) with a
// service-tier RBAC guard (ChatsAccessGuard). US1 conversations + US2 messages; feed lands in US3.
@Module({
  imports: [ChatsAuthModule],
  controllers: [
    HealthGrpcController,
    ConversationReadController,
    ConversationWriteController,
    MessageReadController,
    MessageWriteController,
    FeedReadController,
    // Feature 013 (roadmap 4.4/4.5): the workflow layer.
    AssignmentWriteController,
    AutoAssignController,
    LabelsController,
    MacrosController,
    CannedController,
    // Feature 014 (roadmap 4.6): rule authoring + run-record reads.
    AutomationsController,
    // Feature 014 (roadmap 4.7): the SLA target, plus the maintenance sweep. The maintenance
    // controller is a SEPARATE gRPC service with no gateway route and a system-actor gate (research
    // R3) — it is the only caller of the single unscoped id-only read.
    SlaController,
    SlaMaintenanceController,
  ],
  providers: [
    PrismaService,
    ConversationRepository,
    MessageRepository,
    ChatsAccessGuard,
    // Feature 013.
    AssignmentRepository,
    RoundRobinStateRepository,
    LabelsRepository,
    MacrosRepository,
    CannedRepository,
    // Feature 014.
    DomainEventDispatcher,
    DomainEventPublisher,
    AutomationsRepository,
    AutomationEngine,
    SlaRepository,
    SlaSweepRepository,
    FirstReplyClock,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    @Inject(DomainEventDispatcher) private readonly dispatcher: DomainEventDispatcher,
    @Inject(AutomationEngine) private readonly engine: AutomationEngine,
  ) {}

  /**
   * Wire the automation engine to the event stream (feature 014). This is the ONLY subscription:
   * controllers publish, the engine consumes, and the engine's own writes go through repositories
   * that cannot publish — so there is no cycle to break (FR-006 / research R4).
   */
  onModuleInit(): void {
    this.dispatcher.subscribe((event) => this.engine.handle(event));
  }
}
