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
  'record.open': {
    class: 'access',
    writer: 'users',
    status: 'deferred',
    label: 'Customer record opened',
  },

  // ── export (roadmap 4.10) ──
  'export.create': {
    class: 'export',
    writer: 'worker',
    status: 'no-writer-yet',
    label: 'Data export created',
  },

  // ── assignment (roadmap 5.7 / SEC-AP3) ──
  'player.assign': {
    class: 'assignment',
    writer: 'users',
    status: 'no-writer-yet',
    label: 'Player attached to an account manager',
  },
  'player.unassign': {
    class: 'assignment',
    writer: 'users',
    status: 'no-writer-yet',
    label: 'Player detached from an account manager',
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
