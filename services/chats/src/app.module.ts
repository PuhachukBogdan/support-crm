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
// Feature 022 (roadmap 4.13): contact history + last contact for the player card.
import { ContactSummaryController } from './contact/contact.grpc.controller';
import { ContactSummaryRepository } from './contact/contact-summary.repository';
// Feature 022: chats → users for person membership. The rpc has existed since feature 020 and had no
// caller; the module that finally makes the call is registered here (a module nobody imports contributes
// no providers, which is feature 015's live-only defect one level up).
import { ChatsPersonModule } from './person/person-members.client';
import { AssignmentRepository } from './assignment/assignment.repository';
import { AssignmentWriteController } from './assignment/assignment.grpc.controller';
import { LabelsRepository } from './labels/labels.repository';
import { LabelsController } from './labels/labels.grpc.controller';
import { MacrosRepository } from './macros/macros.repository';
import { MacrosController } from './macros/macros.grpc.controller';
import { CannedRepository } from './canned/canned.repository';
import { CannedController } from './canned/canned.grpc.controller';
import { RoundRobinStateRepository } from './assignment/round-robin-state.repository';
import { GroupPoolService } from './assignment/group-pool';
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
// Feature 023 (roadmap 4.8a): the transition stream. The recorder is a provider called from inside
// repository transactions; the controller is its ONLY read surface and returns counts.
import { TransitionMaintenanceController } from './transition/transition.grpc.controller';
import { TransitionHealthRepository } from './transition/transition.repository';
import { SubjectSweepRepository } from './subject/subject.sweep';
import { TransitionRecorder } from './transition/transition.recorder';
// Feature 015 (roadmap 4.8): the audit trail — this service's source of the federated log.
import { AuditRepository } from './audit/audit.repository';
import { ExportController } from './export/export.grpc.controller';
import { ExportMaintenance } from './export/export.maintenance';
import { ExportProducer } from './export/export.producer';
import { ExportQuota } from './export/export.quota';
import { ExportRepository } from './export/export.repository';
import { ExportService } from './export/export.service';
import { AuditReadController } from './audit/audit.grpc.controller';
import { AuditAccessGuard } from './audit/audit.guard';
// Feature 016 (roadmap 4.9): attachments. chats holds a SOFT upload_id and validates it over the
// users contract — never a cross-database join (Principle VIII). Acyclic: users never calls chats.
import { ChatsUploadsModule } from './uploads/uploads.client';

// Phase 1 (spec 003): health probe. Feature 012 (roadmap 4.1–4.3): the chats-core domain —
// ChatsReadService / ChatsWriteService over chats_db, account-scoped (forAccount) with a
// service-tier RBAC guard (ChatsAccessGuard). US1 conversations + US2 messages; feed lands in US3.
@Module({
  imports: [ChatsAuthModule, ChatsUploadsModule, ChatsPersonModule],
  controllers: [
    HealthGrpcController,
    ConversationReadController,
    ConversationWriteController,
    MessageReadController,
    MessageWriteController,
    FeedReadController,
    // Feature 022 (roadmap 4.13): the card's contact facts — one grouped read over the two columns the
    // message write maintains. Registered here because a controller nobody registers contributes no
    // handlers and the service answers UNIMPLEMENTED while looking perfectly healthy (feature 015's
    // single live-only defect).
    ContactSummaryController,
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
    TransitionMaintenanceController,
    // Feature 015.
    AuditReadController,
    // Feature 017: the export surface + its two maintenance passes.
    ExportController,
  ],
  providers: [
    PrismaService,
    ConversationRepository,
    MessageRepository,
    ChatsAccessGuard,
    // Feature 023 (roadmap 4.8a). The recorder is injected into the repositories that own the write
    // paths — it is never reached from a controller, which is where the automation dispatcher is
    // published from. Two opposite placement rules, protecting two different things (research R1).
    TransitionRecorder,
    TransitionHealthRepository,
    SubjectSweepRepository,
    // Feature 013.
    AssignmentRepository,
    RoundRobinStateRepository,
    // Feature 024 (roadmap 5.3): the group candidate pool. It composes the two clients chats
    // already has — auth for membership, users for the operator profiles — and counts current load
    // from this service's own conversations, which is the one input nobody else can compute.
    GroupPoolService,
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
    // Feature 015.
    AuditRepository,
    AuditAccessGuard,
    // Feature 017 (roadmap 4.10). The producer lives here because `chats` owns the conversation data
    // AND its read path — an export inherits that projection rather than rebuilding one (FR-004a).
    ExportRepository,
    ExportProducer,
    ExportQuota,
    ExportService,
    ExportMaintenance,
    // Feature 022 (roadmap 4.13).
    ContactSummaryRepository,
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
