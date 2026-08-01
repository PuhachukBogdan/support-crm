import { Inject, Injectable, Logger } from '@nestjs/common';
import { hasPermission } from '@crm/common';
import { AuthorAuthorityClient, AuthorityUnavailableError } from '../auth/auth.client';
import { LabelsRepository } from '../labels/labels.repository';
import type { DomainEvent } from '../events/events.types';
import { matches } from './conditions';
import {
  RuleDefinitionError,
  parseDefinition,
  requiredRulePermissions,
  type RuleDefinition,
} from './rule-definition';
import {
  AutomationsRepository,
  type AutomationRow,
  type RunOutcome,
} from './automations.repository';

/**
 * The automation engine (feature 014, US1 — roadmap 4.6).
 *
 * Per event: load the active rules for that trigger in deterministic order, then for each rule
 *
 *   1. re-validate the stored definition        — a blob may predate this code
 *   2. match the conditions                     — pure, no I/O
 *   3. resolve the AUTHOR's live permissions     — memoised per pass (FR-023 / research R5)
 *   4. check every action's own permission       — a rule is never stronger than its author
 *   5. verify referenced entities exist          — e.g. an ADD_LABEL label id
 *   6. ONE transaction: all actions + the run record
 *
 * **Steps 1–5 all happen before the first write.** That ordering — not a rollback — is what makes a
 * refusal leave the conversation completely untouched (FR-005 / SC-002). A rolled-back attempt and a
 * never-started one are equivalent in the database but not in the reasoning: the first depends on
 * every failure path raising correctly, the second cannot go wrong.
 *
 * **No cascade** (FR-006 / research R4): the engine writes through repositories, and repositories
 * cannot publish events. So an automation's own writes produce no event and there is no chain to
 * bound — asserted by `no-cascade.spec.ts` with a deliberately self-satisfying rule.
 */
@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
    @Inject(LabelsRepository) private readonly labels: LabelsRepository,
    @Inject(AuthorAuthorityClient) private readonly authority: AuthorAuthorityClient,
  ) {}

  /** Handle one event. Returns how many rules actually applied. */
  async handle(event: DomainEvent): Promise<number> {
    const rules = await this.automations.listActiveByTrigger(event.accountId, event.trigger);
    if (rules.length === 0) return 0;

    // Memoised ONLY for this pass: several rules by the same author cost one auth hop, and there is
    // no cross-request cache to go stale (research R5).
    const authorityCache = new Map<string, string[] | AuthorityUnavailableError>();
    let applied = 0;

    for (const rule of rules) {
      if (await this.evaluate(rule, event, authorityCache)) applied += 1;
    }
    return applied;
  }

  /** Evaluate one rule. Returns true when its actions were applied. */
  private async evaluate(
    rule: AutomationRow,
    event: DomainEvent,
    authorityCache: Map<string, string[] | AuthorityUnavailableError>,
  ): Promise<boolean> {
    // 1. Re-validate. A rule stored by a looser version must not run under a guessed meaning.
    let def: RuleDefinition;
    try {
      def = parseDefinition(rule.definition);
    } catch (err) {
      await this.record(rule, event, 'refused', reasonOf(err, 'definition is not applicable'));
      return false;
    }

    // 1a. The GROUP SCOPE (feature 024, roadmap 5.3 — ADR 0039 §5.2). A rule bound to a desk sees
    //     only that desk's work. Checked BEFORE the conditions because it is not a condition: it
    //     narrows what the rule is about, rather than being something its author reasons over.
    //
    // ⚠️ **A dangling scope matches NOTHING, and it does so by construction rather than by a check.**
    // Chats cannot see auth's tables, so there is no "does this group still exist?" lookup here — and
    // none is needed: a deleted group is never again the routed group of anything, so the comparison
    // simply stops matching. The dangerous alternative — treating an unresolvable scope as "no
    // filter" — is unreachable, which matters because a scoped rule silently becoming an
    // everything rule is invisible until it has already acted.
    if (rule.scope_group_id && event.facts.routedGroupId !== rule.scope_group_id) {
      await this.record(rule, event, 'not_matched', 'outside the rule’s group scope');
      return false;
    }

    // 2. Conditions (pure). A non-match is recorded so "why did nothing happen?" is answerable.
    if (!matches(def.conditions, event.facts)) {
      await this.record(rule, event, 'not_matched');
      return false;
    }

    // 3. The author's CURRENT authority.
    const perms = await this.resolveAuthority(rule, event, authorityCache);
    if (perms instanceof AuthorityUnavailableError) {
      // Fail-closed (FR-024): never applied on assumed authority.
      await this.record(rule, event, 'refused', `author authority unavailable: ${perms.detail}`);
      return false;
    }

    // 4. Every action's own permission, BEFORE any write. Authoring a rule is not a way around a
    //    permission its author does not hold (Principle II).
    for (const key of requiredRulePermissions(def)) {
      if (!hasPermission(perms, key)) {
        await this.record(rule, event, 'refused', `author lacks ${key}`);
        return false;
      }
    }

    // 5. Referenced entities must exist in the account — otherwise the transaction could fail
    //    halfway on a foreign/deleted label id (spec Edge Case: a rule naming a deleted label is
    //    refused as invalid, not partially applied).
    for (const a of def.actions) {
      if (a.type === 'MACRO_ACTION_TYPE_ADD_LABEL') {
        if (!(await this.labels.exists(event.accountId, a.value))) {
          await this.record(rule, event, 'refused', 'referenced label not found');
          return false;
        }
      }
    }

    // 6. Actions + run record in one batch. A duplicate event_key aborts it → nothing applied.
    return this.automations.applyWithRun(event.accountId, event.conversationId, def.actions, {
      automationId: rule.id,
      automationRevision: rule.revision,
      conversationId: event.conversationId,
      trigger: event.trigger,
      eventKey: event.eventKey,
      outcome: 'applied',
    });
  }

  private async resolveAuthority(
    rule: AutomationRow,
    event: DomainEvent,
    cache: Map<string, string[] | AuthorityUnavailableError>,
  ): Promise<string[] | AuthorityUnavailableError> {
    const cached = cache.get(rule.author_user_id);
    if (cached !== undefined) return cached;
    try {
      const { permissionKeys } = await this.authority.resolve(event.accountId, rule.author_user_id);
      cache.set(rule.author_user_id, permissionKeys);
      return permissionKeys;
    } catch (err) {
      const failure =
        err instanceof AuthorityUnavailableError
          ? err
          : new AuthorityUnavailableError(err instanceof Error ? err.name : 'unknown');
      cache.set(rule.author_user_id, failure);
      return failure;
    }
  }

  /** Write a no-change run record. Its failure must never break the human action that triggered us. */
  private async record(
    rule: AutomationRow,
    event: DomainEvent,
    outcome: RunOutcome,
    reason?: string,
  ): Promise<void> {
    try {
      await this.automations.recordRun(event.accountId, {
        automationId: rule.id,
        automationRevision: rule.revision,
        conversationId: event.conversationId,
        trigger: event.trigger,
        eventKey: event.eventKey,
        outcome,
        reason,
      });
    } catch (err) {
      // Ids + reason class only — never facts, never message text (Principle IV / SEC-26).
      this.logger.warn(
        `could not record automation run for rule ${rule.id}: ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
  }
}

/** A short, PII-free reason for a refusal. */
function reasonOf(err: unknown, fallback: string): string {
  return err instanceof RuleDefinitionError && err.message ? err.message : fallback;
}
