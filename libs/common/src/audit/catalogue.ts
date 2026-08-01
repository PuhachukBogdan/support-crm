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
