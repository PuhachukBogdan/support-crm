/**
 * System permission catalogue + role default matrix (feature 011, ADR 0034). The single source
 * of truth for both the seed (T025) and the whole-role RESET (T033 — "restore the role's default
 * template"). Brand-neutral keys only (Principle VI). Adding a permission here and NOT listing it
 * in a role's defaults means it is OFF for that role until explicitly granted (R-2 corollary).
 *
 * Categories: crm | analytics | users | reports | platform (extensible — 0034).
 */
export interface CatalogueEntry {
  category: string;
  key: string;
  label: string;
}

export const SYSTEM_CATALOGUE: readonly CatalogueEntry[] = [
  // CRM
  { category: 'crm', key: 'crm.inbox.view', label: 'View inbox' },
  { category: 'crm', key: 'crm.conversation.reply', label: 'Reply in conversations' },
  { category: 'crm', key: 'crm.contact.view', label: 'View contact card' },
  { category: 'crm', key: 'crm.contact.read_pii', label: 'Read contact PII' },
  { category: 'crm', key: 'crm.macros.use', label: 'Use macros' },
  // CRM — conversation workflow (feature 013, roadmap 4.4/4.5). `crm.macros.use` above stays the
  // APPLY-a-macro key; authoring templates is a separate, lead/admin-level capability (research R2).
  { category: 'crm', key: 'crm.conversation.assign', label: 'Assign conversations' },
  { category: 'crm', key: 'crm.labels.manage', label: 'Manage & apply labels' },
  { category: 'crm', key: 'crm.templates.manage', label: 'Author macros & canned responses' },
  // CRM — automations + first-reply SLA (feature 014, roadmap 4.6/4.7). Two keys, not five
  // (research R9): authoring rules is one supervisory privilege, setting the reply target another.
  // The new SET_PRIORITY action reuses `crm.conversation.reply`, following 013's precedent for
  // SET_STATUS — a rule can never perform an action its AUTHOR could not perform directly (FR-023).
  { category: 'crm', key: 'crm.automations.manage', label: 'Author automation rules' },
  { category: 'crm', key: 'crm.sla.manage', label: 'Manage the first-reply SLA target' },
  // CRM — exports (feature 017, roadmap 4.10). ONE KEY PER SCOPE, not one blanket `crm.exports.*`:
  // a future contact-bearing or audit-log scope must not inherit the grant that today's conversation
  // export carries. Deliberately in no operational role template, so it is OFF for every agent until
  // granted (the 011 R-2 corollary); `admin`/`super_admin` receive it through ALL_KEYS, which is the
  // broad-by-default choice 0032 §4A made — and which does not relax SEC-AP2, since no v1 export
  // scope carries contact data at all.
  { category: 'crm', key: 'crm.exports.conversations', label: 'Export conversations' },
  // Analytics
  { category: 'analytics', key: 'analytics.dashboard.view', label: 'View dashboards' },
  { category: 'analytics', key: 'analytics.reports.view', label: 'View reports' },
  // Users
  { category: 'users', key: 'users.list.view', label: 'View user list' },
  { category: 'users', key: 'users.portfolio.view', label: 'View VIP portfolio' },
  { category: 'users', key: 'users.am_notes.edit', label: 'Edit AM notes' },
  // Reports
  { category: 'reports', key: 'reports.export', label: 'Export reports' },
  // Platform
  { category: 'platform', key: 'platform.settings.manage', label: 'Manage settings' },
  { category: 'platform', key: 'platform.audit.view', label: 'View audit log' },
  { category: 'platform', key: 'platform.role.manage', label: 'Manage roles & permissions' },
  // Feature 024 (roadmap 5.3, ADR 0039). Deliberately NOT a reuse of `platform.role.manage`:
  // that key is a super-admin exclusive (FR-018), while reorganising a desk is a routine
  // operational task. Reusing it would either hand out the crown jewels or make groups unusable.
  // One key per scope, as feature 017 established for exports — so a later group capability cannot
  // inherit today's grant. Listed in NO operational role template: `admin`/`super_admin` receive it
  // through the computed ALL_KEYS, every agent role does not (the R-2 corollary).
  { category: 'platform', key: 'platform.group.manage', label: 'Manage groups & their members' },
  // "view-as-role" preview (US5). Super-admin default only; the owner ("God") revokes it from any
  // other super-admin via the override mechanism to become the sole holder (design decision — 0034).
  { category: 'platform', key: 'platform.view_as', label: 'Preview the app as any role (read-only)' },
] as const;

/** Every catalogue key (helper for role-default expansion). */
const ALL_KEYS = SYSTEM_CATALOGUE.map((e) => e.key);

/**
 * Role → default permission keys (the template / matrix row). `super_admin` gets everything
 * (incl. `platform.role.manage`, which no other role has — FR-018). Keys must exist in
 * SYSTEM_CATALOGUE.
 */
export const ROLE_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  support_agent: [
    'crm.inbox.view',
    'crm.conversation.reply',
    'crm.contact.view',
    'crm.macros.use',
    // Feature 013 — routing + labelling are everyday agent actions; authoring templates is not.
    'crm.conversation.assign',
    'crm.labels.manage',
  ],
  vip_support: [
    'crm.inbox.view',
    'crm.conversation.reply',
    'crm.contact.view',
    'crm.macros.use',
    'users.portfolio.view',
    'crm.conversation.assign',
    'crm.labels.manage',
  ],
  am: [
    'crm.inbox.view',
    'crm.conversation.reply',
    'crm.contact.view',
    'crm.contact.read_pii',
    'crm.macros.use',
    'users.portfolio.view',
    'users.am_notes.edit',
    'analytics.dashboard.view',
    'crm.conversation.assign',
    'crm.labels.manage',
  ],
  shift_am: [
    'crm.inbox.view',
    'crm.conversation.reply',
    'crm.contact.view',
    'crm.contact.read_pii',
    'crm.macros.use',
    'users.portfolio.view',
    'users.am_notes.edit',
    'analytics.dashboard.view',
    'analytics.reports.view',
    'crm.conversation.assign',
    'crm.labels.manage',
  ],
  teamlead: [
    'crm.inbox.view',
    'crm.conversation.reply',
    'crm.contact.view',
    'crm.macros.use',
    'analytics.dashboard.view',
    'analytics.reports.view',
    'users.list.view',
    'crm.conversation.assign',
    'crm.labels.manage',
    // Authoring macros / canned responses is a lead-level configuration task (R2).
    'crm.templates.manage',
    // Feature 014 — the same lead-level configuration class: encoding routine reactions as rules
    // and setting the reply target. Deliberately NOT given to any operational agent role, so a new
    // key stays OFF for every existing agent until granted (the 011 R-2 corollary).
    'crm.automations.manage',
    'crm.sla.manage',
  ],
  // admin gets everything EXCEPT the two super-admin exclusives: role management (FR-018) and
  // the view-as preview (US5 — God/super-admin only).
  admin: ALL_KEYS.filter((k) => k !== 'platform.role.manage' && k !== 'platform.view_as'),
  super_admin: ALL_KEYS,
} as const;

export const ROLE_KEYS = Object.keys(ROLE_DEFAULTS);
