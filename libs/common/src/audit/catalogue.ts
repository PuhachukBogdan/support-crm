/**
 * The closed audit-action catalogue (feature 015, roadmap 4.8 — ADR 0019, extended by 0032).
 *
 * ── Why closed ──────────────────────────────────────────────────────────────────────────────────────
 * An audit log is read years after it is written, usually by someone who was not there. Free-text actions
 * make it unqueryable: "show me every permission change" only works if there is one spelling, not four
 * ("perm_grant", "permission granted", "grantPermission"). So an unknown action is REFUSED at write time —
 * the same discipline as the permission catalogue (feature 011) and the automation trigger catalogue
 * (feature 014).
 *
 * ── Why the not-yet-written classes are here anyway ────────────────────────────────────────────────
 * Because feature 011 shows what happens otherwise: it needed to record permission changes, invented
 * `PrivilegeAudit`; then needed to record contact views, invented `ContactViewAudit`. Two stores, two
 * shapes, a reader who has to know both exist. Defining `export.create` / `player.assign` /
 * `account.delete` now means the features that introduce them write HERE.
 *
 * `status` is load-bearing, not documentation:
 *   • `live`          — a writer exists in the product today.
 *   • `no-writer-yet` — the class is defined; the feature that writes it has not shipped.
 *   • `deferred`      — deliberately NOT to be written yet (`record.open` needs a retention policy first).
 * A spec asserts the exact membership of each, so promoting one is a visible act rather than a quiet one.
 *
 * Pure data + pure helpers. No I/O.
 */

export const AUDIT_CLASSES = [
  'privilege', // permission / role changes (0019)
  'deletion', // deletions, incl. account deletion (0019 / SEC-41)
  'access', // access to customer records (0019) + contact reveals (0032/SEC-AP3)
  'export', // data exports (0019)
  'assignment', // player↔account-manager changes (0032/SEC-AP3)
  'retention', // trimming the trail — the one act that can destroy history
  // W27 / 036 (9.16): WHERE a conversation is — the shelf's four verbs. Not `deletion`: that class
  // records destructions and its detail identifies what stopped existing; a shelved conversation
  // exists, keeps its history, and comes back. A class is added by decision, never by reflex — this
  // one arrived with spec 036, whose criterion ④ is exactly that these acts stay readable.
  'lifecycle',
] as const;

export type AuditClass = (typeof AUDIT_CLASSES)[number];

/** Which service owns the writer (and therefore the table the entry lands in). */
export type AuditWriter = 'auth' | 'users' | 'chats' | 'worker';

export type AuditStatus = 'live' | 'no-writer-yet' | 'deferred';

export interface AuditActionSpec {
  class: AuditClass;
  writer: AuditWriter;
  status: AuditStatus;
  /** One line a reader of the catalogue (not of the code) can understand. */
  label: string;
}

export const AUDIT_ACTIONS = {
  // ── privilege (auth) — absorbs feature 011's PrivilegeAudit ──
  'role.assign': { class: 'privilege', writer: 'auth', status: 'live', label: 'Role assigned' },
  'role.revoke': { class: 'privilege', writer: 'auth', status: 'live', label: 'Role revoked' },
  'permission.grant': { class: 'privilege', writer: 'auth', status: 'live', label: 'Permission granted' },
  'permission.revoke': { class: 'privilege', writer: 'auth', status: 'live', label: 'Permission revoked' },
  'permission.reset': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Permissions reset to role defaults',
  },

  // ── privilege, continued: GROUPS (feature 024, roadmap 5.3 / ADR 0039) ──
  //
  // `privilege` and not a new class, deliberately. Adding someone to a group GRANTS ACCESS — that is
  // the entire premise of ADR 0039, and it is the same reason 5.7's self-assignment carried an audit
  // condition. A separate class would split one reviewable question ("who gained rights, and how?")
  // across two filters, and the reader years later would have to know both exist.
  //
  // Deleting a group is filed here rather than under `deletion` for the same reason: what matters
  // about it is that every member LOSES the group's grants, not that a row went away.
  // ⚠️ The membership and grant actions are `group_member.*` / `group_permission.*`, NOT
  // `group.member.add`. The catalogue's naming convention is **noun.verb** — exactly two segments —
  // and it is asserted by `catalogue.spec.ts`. The first draft here used three and the guard caught
  // it, which is the convention doing its job: `role.assign` and `permission.grant` are the same
  // shape, so a reader filtering the trail never has to know how deep an action's name goes.
  'group.create': { class: 'privilege', writer: 'auth', status: 'live', label: 'Group created' },
  'group.rename': { class: 'privilege', writer: 'auth', status: 'live', label: 'Group renamed' },
  'group.delete': { class: 'privilege', writer: 'auth', status: 'live', label: 'Group deleted' },
  /**
   * ⭐ Feature 031 (ADR 0042) — a desk was switched into, or out of, automatic distribution.
   *
   * ⚠️ **A distinct action, not folded into `group.rename`.** Renaming a desk changes a label nothing
   * branches on (ADR 0039 §9); making it routable changes **who receives customer conversations without
   * anybody choosing**. Two facts of very different weight under one action name would make the trail
   * unreadable for the question that matters: *when did this desk start being fed by the router?*
   *
   * `privilege` class, like every other group mutation: it changes what a set of people receive.
   */
  'group.routability_changed': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Group routability changed',
  },
  'group_member.add': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Staff member added to a group',
  },
  'group_member.remove': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Staff member removed from a group',
  },
  'group_permission.grant': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Permission granted to a group',
  },
  // There is no "deny" counterpart and there never will be: a group grants and never denies
  // (ADR 0039 §3). Revoking returns the group to silence about a key; it does not refuse it.
  'group_permission.revoke': {
    class: 'privilege',
    writer: 'auth',
    status: 'live',
    label: 'Permission revoked from a group',
  },
  // ── Feature 025 (roadmap 5.9): setting SOMEBODY ELSE's presence. ──
  //
  // ⚠️ Changing one's OWN presence is deliberately NOT here and never will be. A statement about
  // oneself is history (a transition), not a sensitive action — and ~58 agents toggling several
  // times a day would bury the entries that matter, which is the same reasoning that keeps the UI
  // preference toggle out of this catalogue.
  //
  // Class `privilege` is a REUSE and it is worth being honest about the fit: this changes no
  // permission. What it does is override a person's own statement about themselves and redirect the
  // work the system gives them, without their involvement — the accountability need the class exists
  // for. A dedicated class for *acts performed on a colleague* would be better, and it earns its
  // existence at roadmap 3.15/3.16, when provisioning and deactivation give it three tenants.
  // Recorded here so that stays a decision rather than becoming an accident.
  'presence.override': {
    class: 'privilege',
    writer: 'users',
    status: 'live',
    label: "Another operator's presence was set by an administrator",
  },

  // ── deletion ──
  'automation.delete': {
    class: 'deletion',
    writer: 'chats',
    status: 'live',
    label: 'Automation rule deleted',
  },
  // No deletion path exists yet (SEC-41): defined so the feature that adds one writes here.
  'account.delete': {
    class: 'deletion',
    writer: 'auth',
    status: 'no-writer-yet',
    label: 'Account deleted',
  },

  // ── access — absorbs feature 011's ContactViewAudit ──
  'contact.reveal': {
    class: 'access',
    writer: 'users',
    status: 'live',
    label: "Player's protected contact fields revealed",
  },
  // Reading the audit log is itself a sensitive act: "who went looking at who accessed what" is the same
  // accountability question one level up, and the volume is trivial.
  'audit.read': { class: 'access', writer: 'auth', status: 'live', label: 'Audit log read' },
  // W9 / spec 035 (ADR 0044 §4) — the anti-pitching inversion, audited on EVERY attempt: found,
  // not-found, ambiguous and refused-by-cap alike (volume over time is the only available signal, so
  // a refused attempt is still a data point). Detail carries {valueHash, valueKind, matched} — the
  // SALTED HASH of the searched value, never the value: an investigator confirms "was this number
  // looked up" by hashing it; nobody reads the number out of the log. Restricted class, short
  // retention (0046 §U7: 90 days) — the retention machinery itself is SEC-25, still open.
  'contact.lookup': {
    class: 'access',
    writer: 'users',
    status: 'live',
    label: 'Player looked up by contact value',
  },
  // DEFERRED, deliberately (spec Q1): logging every record open is the busiest write path in the product
  // and would arrive before any retention policy. It ships WITH retention, not before.
  // ⚠️ Feature 018 (roadmap 5.1) tried to make this `live` and REVERTED, which is worth recording so the
  // next attempt starts from the real blocker rather than rediscovering it.
  //
  // The gap is real: a read surfacing only open fields writes nothing, so the reads of the most numerous
  // role are invisible in the trail — the quiet-harvesting shape SEC-AP3 exists to detect, one tier below
  // where anyone was looking. Feature 018 wired it best-effort and `tests/audit/no-best-effort.spec.ts`
  // refused the change, correctly: feature 015 attached a PRECONDITION to this row — best-effort belongs
  // to this class *when it ships WITH a retention policy* — and retention (SEC-25) is still open.
  //
  // This is the highest-volume entry class in the product. Wiring it without a retention policy means
  // unbounded growth in the very table that records who looked at customer data, and 015's instruction was
  // to DECIDE that first rather than accept it. So this stays `deferred` until SEC-25 is answered; the code
  // change itself is one branch in users/src/player/contact-view-audit.service.ts.
  'record.open': {
    class: 'access',
    writer: 'users',
    status: 'deferred',
    label: 'Customer record opened',
  },

  // ── export (roadmap 4.10) ──
  //
  // ⚠️ WRITER CORRECTED by feature 017: `worker` → `chats`, `no-writer-yet` → `live`.
  //
  // Feature 015 defined this row before anyone knew what v1 would export, and guessed the worker
  // because 4.10 says "dispatched to Worker". The worker turned out to be the wrong answer for a
  // reason 015 itself had already fixed: an entry must sit inside its action's transaction, and the
  // worker HAS NO DATABASE — it schedules and holds no state. With v1 scoped to conversations, the
  // transaction holding the facts is in `chats`, which already has an identical audit table.
  //
  // The detail allow-list below was right all along, and it is the evidence: `rowCount` is only
  // knowable once the artefact exists, so 015 had already placed this entry at COMPLETION. Only the
  // writer label predated the scope decision.
  'export.create': {
    class: 'export',
    writer: 'chats',
    status: 'live',
    label: 'Data export created',
  },

  // ── assignment (roadmap 5.7 / SEC-AP3) ──
  // ── Feature 026 (roadmap 5.7): promoted from `no-writer-yet` to `live`. ──
  //
  // Reserved by feature 015 for exactly this moment, so that the feature which needed them would
  // write HERE rather than invent a second store. That is the mechanism working.
  //
  // ⚠️ These two carry more weight than their class name suggests. ATTACHMENT GRANTS ACCESS: a
  // manager can attach a player to themselves without an administrator, read the portfolio, and
  // detach. No rule is broken and the data is gone. The audit is not a nicety here — it is the
  // stated PRICE of the self-service capability the operator asked for, and the trail has to make
  // abnormal volume computable (which is why `assigned_by` is stored separately from the manager).
  'player.assign': {
    class: 'assignment',
    writer: 'users',
    status: 'live',
    label: 'Player attached to an account manager',
  },
  'player.unassign': {
    class: 'assignment',
    writer: 'users',
    status: 'live',
    label: 'Player detached from an account manager',
  },
  // W9 / spec 035 (ADR 0044 §5) — a CONVERSATION gaining/losing its player, distinct from
  // player.assign's manager↔player pair. Two separate events, both under the same key that gates
  // the lookup (`crm.contact.lookup`); detail carries {playerId, brandId} — the PAIR, because a
  // bare player id names two customers (the 07-29 Person repair). The detach event is what makes
  // "what was written while the wrong player was attached" a computable window (0044 §5's hazard).
  'conversation.player_attach': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'Conversation attached to a player',
  },
  'conversation.player_detach': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'Conversation detached from its player',
  },

  // ⭐ W29 (R46): a macro's removal. `deletion` class — its `name` detail key exists exactly for
  // this: after the row is gone, the trail is the only place the name survives. Deletion is why the
  // authoring screen can be trusted with ~97 hand-entered macros: a typo is removable, on record.
  'macro.delete': {
    class: 'deletion',
    writer: 'chats',
    status: 'live',
    label: 'Macro deleted',
  },

  // ── W27 / feature 036 (roadmap 9.16) — the shelf: the four verbs of the third place ───────────
  //
  // ⚠️ The DELETE here is criterion ④'s subject: it removes a conversation from every list and it
  // removes NOTHING from this trail — these four entries are what make that checkable. Detail
  // carries {fromState, toState}; same→same writes no entry at all (the presence precedent).
  // `lifecycle` class: they are facts about where the conversation IS, not about who works it.
  'conversation.suspend': {
    class: 'lifecycle',
    writer: 'chats',
    status: 'live',
    label: 'Conversation suspended (held out of every queue)',
  },
  'conversation.release': {
    class: 'lifecycle',
    writer: 'chats',
    status: 'live',
    label: 'Conversation released from suspension',
  },
  'conversation.delete': {
    class: 'lifecycle',
    writer: 'chats',
    status: 'live',
    label: 'Conversation soft-deleted (recoverable)',
  },
  'conversation.restore': {
    class: 'lifecycle',
    writer: 'chats',
    status: 'live',
    label: 'Conversation restored from the deleted bucket',
  },

  /**
   * ⭐ Feature 031 (roadmap 4.20, ADR 0042 §5) — a conversation that can reach NOBODY.
   *
   * ⚠️ **An audited event and NOT a notification, stated plainly** (research R7/D-5). There is no alerting
   * surface in this product: 7.5 is the n8n ingest and 9.18 is the audit viewer, and neither exists yet. An
   * alarm with no consumer is the *written-with-nobody-to-read-it* defect this project already shipped once,
   * when the audit log ran for five features with no screen — so the honest form is a recorded fact plus a
   * named future reader, rather than a `console.error` that nothing collects.
   *
   * `assignment` class: it is a fact about work failing to reach a person. `reasonClass` only — never which
   * customer, never a contact value.
   */
  'conversation.unroutable': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'Conversation could not be routed to anybody',
  },

  // ── identity (feature 020, roadmap 5.2 / ADR 0038 §3) ──
  //
  // Two records becoming one person is a statement about a HUMAN, and it is made AUTOMATICALLY on a
  // matching email or phone. An automatic decision needs a record of itself: without these entries a
  // wrong link would be visible only as a customer card that quietly contains someone else.
  //
  // The entry names WHICH KIND of identifier established it (`email` | `phone`) and never the value —
  // the class's existing allow-list already permits a bare kind, and that it needs no allow-list change
  // is the evidence this shape was anticipated rather than improvised.
  'player.link': {
    class: 'assignment',
    writer: 'users',
    status: 'live',
    label: 'Two player records recognised as one person',
  },
  'player.unlink': {
    class: 'assignment',
    writer: 'users',
    status: 'live',
    label: 'A player record separated from a person',
  },

  /**
   * ⭐ Feature 032 (roadmap 4.16, R22 — amends ADR 0038) — a conversation was moved to another brand.
   *
   * Brand is auto-assigned at ingestion and READ-ONLY for agents; a supervisor may correct it. Audited
   * because brand drives reporting and record identity: a silent correction rewrites past numbers with
   * nothing to point at, which is exactly the class ADR 0019's store exists for.
   *
   * ⚠️ Class `assignment`, and the closest precedent is `player.link` two rows above: both are statements
   * about WHICH RECORD a thing belongs to. It is a reuse worth being honest about — no permission changes
   * and no customer data is exposed. A dedicated *record-identity* class would be a better fit and earns
   * its existence when a second act needs it (the same reasoning `presence.override` records for its own
   * reuse); inventing it for one action would split one reviewable question across two filters.
   *
   * ⚠️ NOT a transition. R22 asks for accountability, not history: a `conversation.brand_changed`
   * transition type would have no reader today, which is the *written-with-nobody-to-read-it* shape this
   * project shipped once already.
   */
  'conversation.brand_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'Conversation moved to another brand',
  },

  // ── channels (feature 033, roadmap 6.1/6.4/6.5/6.6) ──
  //
  // These four are the first audited acts whose ACTOR is not a person. A stranger's delivery, a mailbox,
  // a retry — there is no operator to name, and that is precisely why they are recorded: the intake path
  // is the only place in the product where something happens because an outsider asked.
  //
  // ⚠️ **Every one of them is expressible without a contact value, and that is a constraint on the
  // entry rather than a hope about the caller.** The detail allow-list of the `assignment` class already
  // permits a bare identifier KIND (`email` | `phone` | `player_id`) — the shape feature 020 established
  // for `player.link` — so a resolution can be recorded as "matched on an email" and can never be
  // recorded as "matched on ann@example.test".

  /**
   * A delivery was refused at the channel edge — bad signature, no derivable event id, a loop, an
   * unparseable message, a disabled channel, an account with no `new` status configured.
   *
   * Recorded because a refusal that leaves no trace is indistinguishable from a delivery that never
   * arrived, and those two have opposite causes: one is our rejection, the other is somebody else's
   * outage. `refusalClass` only — never the payload, never the signature, never the secret.
   */
  'channel.intake_refused': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'An inbound channel delivery was refused',
  },
  /**
   * Intake decided who wrote — or decided that it could not tell.
   *
   * The counterpart to `player.link`: that one records two records becoming one person, this one records
   * a conversation being attached to a person automatically, by whatever the channel carried. Both are
   * automatic decisions about identity, and an automatic decision needs a record of itself — a wrong
   * attachment is otherwise visible only as a customer card that quietly contains someone else's words.
   *
   * ⚠️ The identifier CLASS is recorded and the value never is (ADR 0044 §4's rule, applied here to the
   * automatic path rather than to the agent's lookup).
   */
  'channel.identity_resolved': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'Intake resolved (or failed to resolve) who wrote',
  },
  /**
   * A customer's reply reopened a ticket that had been solved.
   *
   * ⚠️ Audited **as well as** recorded as a transition, which is unusual and deliberate. The transition
   * is the history a person reads on the ticket; the audit entry is the accountability record for a
   * state change **nobody authorised** — the same reason `conversation.brand_changed` exists, except the
   * actor here is an email rather than a supervisor. A ticket that reopens itself with no trace is a
   * closed-work number that changes with nothing to point at.
   *
   * Its sibling case leaves no entry, correctly: a reply to a `closed` ticket creates a NEW ticket, and
   * creating a ticket is not a state change needing accountability — the link on the row is the record.
   */
  'conversation.reopened_by_reply': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'A customer reply reopened a solved conversation',
  },
  /**
   * An outbound message was refused before it left — the capability matrix said the channel cannot
   * carry it, or the egress guard refused the host.
   *
   * ⚠️ Recorded because THIS is the refusal most likely to be mistaken for success. A message that was
   * never sent and never complained about looks, from inside the product, exactly like one that was
   * delivered; the customer's silence is the only symptom, and it arrives days later. `reasonClass`
   * only — never the recipient, never the body, never the relay's own sentence.
   */
  'channel.send_refused': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'An outbound channel message was refused before sending',
  },
  /**
   * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — an admin created or changed a channel's configuration.
   *
   * The first channel action whose actor IS a person: the four above record what intake and egress did by
   * themselves, this one records what an administrator did to the rows they act under. Audited because a
   * channel row decides WHICH TENANT AND BRAND an arriving delivery belongs to (`channel.repository.ts`'s
   * own warning) — a quiet edit here re-routes strangers' messages with nothing to point at.
   *
   * ⚠️ Class `assignment`, the same honest reuse `conversation.brand_changed` records two screens up: this
   * is a statement about where arriving records will be filed. `brandRef` + `channelKind` only — never the
   * address (the trail references the row, it does not copy it) and never a secret (the row holds none).
   */
  'channel.config_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'A channel was created or its configuration changed',
  },
  /**
   * ⭐ W15a (subpoint 3.14) — an admin created or changed a ticket status definition.
   *
   * The same reasoning as `channel.config_changed` one entry up: a status's CATEGORY decides which
   * bucket and which report a ticket appears in, so a quiet edit re-files work with nothing to point
   * at — and retiring one changes what every agent may set. Class `assignment` by the same honest
   * reuse; `target_ref` is the status KEY (the identity the conversation FK stands on). NO detail:
   * the row holds its current state and the trail references it rather than copying it — the group
   * rename precedent.
   */
  'status.config_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'A ticket status was created or its definition changed',
  },
  /**
   * ⭐ Feature 037 (roadmap 4.15 — W30) — an admin created or changed a ticket FIELD definition.
   *
   * The `status.config_changed` reasoning, third instance: a field's shape decides what agents may
   * record on a conversation and what analytics will read back, so a quiet edit re-shapes data with
   * nothing to point at. Class `assignment` by the same honest reuse. `target_ref` is the field KEY
   * (the per-account authoring identity). NO detail and NO values — the row holds its current
   * state; the trail references it (the group-rename precedent). Value WRITES on conversations are
   * deliberately not audited — parity with priority/status edits, which ride `conversation.updated`
   * and the transition table instead.
   */
  'field.config_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'A ticket field was created or its definition changed',
  },
  /**
   * Feature 037 — an admin created, changed or deleted an option SET (the value list dropdown
   * fields stand on). Same class, same no-copy rule; `target_ref` is the set id. Deactivating a
   * value that conversations already hold is exactly the kind of quiet reshaping this exists for.
   */
  'option_set.config_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'An option set was created, changed or deleted',
  },
  /**
   * Feature 037 — an admin created or changed a FORM (the ordered field composition that also
   * carries the analytics category and designates the sub-category source). A form edit can
   * re-route classification for every future ticket filed under it — the loudest of the three.
   * `target_ref` is the form KEY.
   */
  'form.config_changed': {
    class: 'assignment',
    writer: 'chats',
    status: 'live',
    label: 'A ticket form was created or its composition changed',
  },

  // ── retention (roadmap 7.3 + ADR 0015) ──
  'audit.trim': {
    class: 'retention',
    writer: 'worker',
    status: 'no-writer-yet',
    label: 'Audit entries trimmed by the retention policy',
  },
} as const satisfies Record<string, AuditActionSpec>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** True only for a catalogue action. A legacy spelling, an unknown value or a non-string is refused. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value);
}

export function classOf(action: AuditAction): AuditClass {
  return AUDIT_ACTIONS[action].class;
}

export function writerOf(action: AuditAction): AuditWriter {
  return AUDIT_ACTIONS[action].writer;
}

/** Every action in a class. An unknown class yields nothing — never everything (fail-closed). */
export function actionsOfClass(auditClass: AuditClass): AuditAction[] {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
    (a) => AUDIT_ACTIONS[a].class === auditClass,
  );
}

export function isAuditClass(value: unknown): value is AuditClass {
  return typeof value === 'string' && (AUDIT_CLASSES as readonly string[]).includes(value);
}
