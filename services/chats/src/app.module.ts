import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';
import { ChatsAccessGuard } from './security/permission.guard';
// ⭐ W32 / feature 039 (roadmap 12.11): chats' half of the security page — channels that are on or
// off, and how many ticket fields are withheld. A registry of readers; see its header for the one
// fact (contact masking) deliberately left off it.
import { SecurityFactsService } from './security/facts.service';
import { SecurityFactsGrpcController } from './security/facts.grpc.controller';
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
// Feature 033 (roadmap 6.4): chats → users for the reply envelope (research R9).
import { ChatsChannelParticipantModule } from './channel/participant.client';
import { ChatsOperatorIdentityModule } from './shared/operator-identity.client';
import { ReadMarkRepository } from './conversation/read-mark.repository';
import { InboxUnseenRepository } from './conversation/inbox-unseen.repository';
import { ThreadResolver } from './channel/threading';
// Feature 033 US4 (roadmap 6.5): the outbox, its sender, and the shared SMTP transport.
import { OutboundRepository } from './channel/outbound.repository';
import { OutboundService } from './channel/outbound.service';
import { ChatsSmtpTransport } from './channel/smtp.transport';
import { MAIL_TRANSPORT } from '@crm/common';
import { AssignmentRepository } from './assignment/assignment.repository';
import { AssignmentWriteController } from './assignment/assignment.grpc.controller';
import { LabelsRepository } from './labels/labels.repository';
import { LabelsController } from './labels/labels.grpc.controller';
import { MacrosRepository } from './macros/macros.repository';
import { MacrosController } from './macros/macros.grpc.controller';
import { CannedRepository } from './canned/canned.repository';
import { CannedController } from './canned/canned.grpc.controller';
import { RoundRobinStateRepository } from './assignment/round-robin-state.repository';
import { BacklogRepository } from './assignment/backlog';
import { BacklogSweepRepository } from './assignment/backlog-sweep.repository';
import { BacklogMaintenanceController } from './assignment/backlog.grpc.controller';
// ⭐ W31 / feature 038 (ADR 0043 §4, SEC-PV2): the offboarding handover — a departed colleague's
// open work goes back to the queue instead of sitting on somebody who no longer exists.
import { HandoverRepository } from './assignment/handover.repository';
import { HandoverMaintenanceController } from './assignment/handover.grpc.controller';
import { GroupPoolService } from './assignment/group-pool';
import { AutoAssignController } from './assignment/auto-assign.grpc.controller';
// Feature 014 (roadmap 4.6/4.7): automations + first-reply SLA.
import { ChatsAuthModule } from './auth/auth.client';
import { DomainEventDispatcher } from './events/events.dispatcher';
import { DomainEventPublisher } from './events/events.publisher';
// Feature 034 (roadmap 7.1, block W4): the FIRST Redis in this service, publish-only. See the file
// header for why that does not overturn the "chats has no Redis" decision — a PUBLISH stores nothing.
import { RealtimePublisher } from './realtime/realtime.publisher';
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
import { StatusRepository } from './status/status.repository';
// Feature 033 (roadmap 6.1/6.5): the channel ingress and the intake path behind it.
import { ChannelIngressController } from './channel/channel.grpc.controller';
import { ChannelRepository } from './channel/channel.repository';
import { IntakeLedger } from './channel/intake.ledger';
import { ChannelIntakeService } from './channel/intake.service';
import { ApiChannelAdapter } from './channel/adapters/api.adapter';
// ⭐ Feature 033 US5 (roadmap 6.6): the third KIND — its contract and the read every later block stands on.
import { MessengerChannelAdapter } from './channel/adapters/messenger.adapter';
import { ChannelCapabilitiesController } from './channel/capabilities.grpc.controller';
// ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10): the channels admin surface — list + a brand's mail address.
import { ChannelAdminController } from './channel/channel-admin.grpc.controller';
import { CHANNEL_CONFIG, loadChannelConfig } from './config';
import { StatusReadController } from './status/status.grpc.controller';
// ⭐ W15a (subpoint 3.14): the status authoring writes — the counterpart the read's header promised.
import { StatusAdminController } from './status/status-admin.grpc.controller';
import { FieldsController } from './fields/fields.grpc.controller';
import { FieldsAdminController } from './fields/fields-admin.grpc.controller';
import { FieldsRepository } from './fields/fields.repository';
// ⭐ W17 (subpoint 4.6): write first — one button, one channel (email).
import { InitiateConversationController } from './conversation/initiate.grpc.controller';
// ⭐ W20 (subpoints 6.2/6.3/6.4): the live numbers, straight from the journal.
import { AnalyticsController } from './analytics/analytics.grpc.controller';
import { AuditAccessGuard } from './audit/audit.guard';
// Feature 016 (roadmap 4.9): attachments. chats holds a SOFT upload_id and validates it over the
// users contract — never a cross-database join (Principle VIII). Acyclic: users never calls chats.
import { ChatsUploadsModule } from './uploads/uploads.client';

// Phase 1 (spec 003): health probe. Feature 012 (roadmap 4.1–4.3): the chats-core domain —
// ChatsReadService / ChatsWriteService over chats_db, account-scoped (forAccount) with a
// service-tier RBAC guard (ChatsAccessGuard). US1 conversations + US2 messages; feed lands in US3.
@Module({
  imports: [
    ChatsAuthModule,
    ChatsUploadsModule,
    ChatsPersonModule,
    ChatsChannelParticipantModule,
    // W5 (roadmap 5.11/4.19): "which operator is the caller" — the rail's mark write needs it.
    ChatsOperatorIdentityModule,
  ],
  controllers: [
    HealthGrpcController,
    ConversationReadController,
    BacklogMaintenanceController,
    // ⭐ W31 / feature 038: `ReturnOperatorWorkToBacklog`. A controller nobody registers answers
    // UNIMPLEMENTED while looking perfectly healthy (feature 015's single live-only defect) — and an
    // offboarding that silently does nothing is the exact shape SEC-PV2 describes.
    HandoverMaintenanceController,
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
    // ⭐ Feature 032 (roadmap 4.16): the account's status catalogue — one read, no write counterpart
    // until the authoring screen (roadmap 3.14) brings its own.
    StatusReadController,
    // ⭐ W15a (subpoint 3.14): that authoring screen's writes — create + edit, `platform.settings.manage`
    // at both tiers, audited in-transaction. A controller nobody registers serves nothing.
    StatusAdminController,
    // ⭐ W17 (subpoint 4.6): write first, by email — the portfolio rule enforced server-side.
    InitiateConversationController,
    // ⭐ W20 (6.2/6.3/6.4): the analytics snapshot — aggregates only, categories never keys.
    AnalyticsController,
    // ⭐ Feature 033 (roadmap 6.1): the channel ingress. ⚠️ The ONLY write controller in this service
    // with no actor context to read — its caller holds no session, and its authentication is the
    // signature the intake service verifies against the channel's own secret.
    ChannelIngressController,
    // ⭐ Feature 033 (roadmap 6.6): the capability matrix as an answer. W6's filters, W7's reply box and
    // W20's analytics all stand on it — and a controller nobody registers answers UNIMPLEMENTED while
    // looking perfectly healthy (feature 015's single live-only defect).
    ChannelCapabilitiesController,
    // ⭐ W15 (roadmap 6.8 minimum): the channels ADMIN surface — tenant configuration, gated
    // `platform.settings.manage` at both tiers, every write audited in its own transaction.
    ChannelAdminController,
    // ⭐ Feature 037 (roadmap 4.15 — W30): custom ticket fields. The agent surface — the per-caller
    // resolved view + the two ticket writes (`crm.conversation.reply`, the SetPriority reasoning).
    FieldsController,
    // ⭐ Feature 037: the authoring surface — fields, option sets, forms; `platform.field.manage`
    // at both tiers, every write audited in-transaction (the status-admin shape).
    FieldsAdminController,
    // ⭐ W32 / 039 (roadmap 12.11): the security page's chats facts. Registered here because an
    // unregistered controller answers UNIMPLEMENTED while looking healthy — and the gateway would
    // then contribute `unknown` for facts that are perfectly fine, which is how the one word on that
    // page that must never be ignored becomes background noise.
    SecurityFactsGrpcController,
  ],
  providers: [
    PrismaService,
    ConversationRepository,
    // W5 (roadmap 4.19): "this operator OPENED this conversation" — the fact under the agent rail.
    ReadMarkRepository,
    // ⭐ W25 (R23/9.12): the unread badge's one fact and its derived count.
    InboxUnseenRepository,
    // Feature 032: read by the two write paths, both list filters, the macro/automation validators and
    // the two load counters. Everything that used to know four status words now asks this.
    StatusRepository,
    // ⭐ Feature 037 (roadmap 4.15 — W30): field definitions, option sets, forms, values, the U9
    // classification lock and the solve gate — all account-scoped, nothing branches on a field key.
    FieldsRepository,
    MessageRepository,
    // ── ⭐ Feature 033 (roadmap 6.1/6.5) — channel intake ─────────────────────────────────────────
    //
    // `CHANNEL_CONFIG` is a value provider rather than a class: the secrets and the replay window are
    // read from the environment once at boot, like every other config in this service, and an absent
    // secret map means every delivery is refused as unverifiable rather than accepted.
    { provide: CHANNEL_CONFIG, useFactory: () => loadChannelConfig() },
    ChannelRepository,
    IntakeLedger,
    ApiChannelAdapter,
    // The kind and the contract ship; the transport does not (2.1i / O1). It states that it cannot send
    // rather than throwing or silently succeeding — see the adapter's own header.
    MessengerChannelAdapter,
    ChannelIntakeService,
    // US2 (roadmap 6.4): where a reply belongs, matched only on identifiers we ourselves stored.
    ThreadResolver,
    // ── US4 (roadmap 6.5): the agent's reply reaches the customer, once ────────────────────────────
    //
    // ⚠️ `MAIL_TRANSPORT` is the SHARED sender from `libs/common`, wrapped by this service's own thin DI
    // shell. Not a second implementation: the egress guard lives inside it, and a copy here would turn
    // the one boundary Principle III depends on into a convention with two allow-lists to keep in step.
    OutboundRepository,
    OutboundService,
    { provide: MAIL_TRANSPORT, useClass: ChatsSmtpTransport },
    ChatsAccessGuard,
    // ⭐ W32 / 039: reads the chats registry for one account, account-scoped like every other read.
    SecurityFactsService,
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
    BacklogRepository,
    // Feature 031: the drain has no caller and therefore no account — see the file header.
    BacklogSweepRepository,
    // ⭐ W31 / feature 038: unassign AND enqueue in ONE transaction (research D6) — doing only the
    // first is the trap `AssignConversation('')` already contains.
    HandoverRepository,
    LabelsRepository,
    MacrosRepository,
    CannedRepository,
    // Feature 014.
    DomainEventDispatcher,
    DomainEventPublisher,
    // Feature 034: publishes "something changed" to the account's channel, after the commit, best-effort.
    RealtimePublisher,
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
