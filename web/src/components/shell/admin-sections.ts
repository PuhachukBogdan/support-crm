/**
 * W13 (subpoint 3.13) — the Admin Center's RESERVED SECTIONS.
 *
 * 3.13 asks for a labelled place for every surface the operator approved but that is not built:
 * Access Management, Macros, Automations, Retention, ticket statuses. None of them is a top-level
 * module — the reference's own rail is Support · Knowledge · Analytics · WFM · Admin (§14), and
 * putting five more entries on it would answer the operator's complaint (*«если их больше четырёх,
 * то их там надо сверху скроллить»*) with precisely the thing he complained about. So they are
 * sections of one page.
 *
 * ⚠️ Each carries the roadmap point that will fill it, and **the point is the promise**: a slot with
 * no owner is how a screen ends up reserved for ever. If a section here has no point, it should not
 * be here.
 *
 * ⓘ These are DESCRIPTIONS, not routes. Nothing is clickable, nothing is focusable — the
 * placeholder convention (`coming-soon.tsx`): a reserved slot says what it is, and cannot be
 * mistaken for a control that does nothing.
 */
export interface AdminSection {
  readonly key: string;
  readonly label: string;
  /** What it will do, in the operator's terms — not ours. */
  readonly summary: string;
  /** The roadmap point that ships it. A section without one has no owner. */
  readonly point: string;
  /**
   * W14: set once the section EXISTS. Absent means reserved — and the page renders a reserved
   * section as plain text precisely so that a placeholder can never look like a working control.
   */
  readonly href?: string;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    key: 'access',
    label: 'Access management',
    summary: 'Who holds which role, and per-person exceptions. The engine is built and audited.',
    point: '9.8',
  },
  {
    key: 'people',
    label: 'People & groups',
    summary: 'Invite, change a role, deactivate; desks and their membership.',
    point: '3.8 / 3.9',
    // ⭐ W14: the first section that stopped being a promise. `href` is what makes the card a link
    // — the others have none, and the page renders them as plain text for exactly that reason.
    href: '/admin/people',
  },
  {
    key: 'channels',
    label: 'Channels',
    summary: 'Mail addresses and the API-channel key.',
    point: '3.10',
    // ⭐ W15: the second section that stopped being a promise.
    href: '/admin/channels',
  },
  {
    key: 'statuses',
    label: 'Ticket statuses',
    summary: 'The nine statuses, their categories and their two names — agent-facing and customer-facing.',
    point: '3.14',
    // ⭐ W15a: the third section that stopped being a promise.
    href: '/admin/statuses',
  },
  {
    key: 'macros',
    label: 'Macros & canned responses',
    summary: 'Authoring the bundles agents apply. Only supervisors may write them.',
    point: '14.4',
  },
  {
    key: 'automations',
    label: 'Automations',
    summary: 'Rules that react to a ticket without a person — the engine exists, the screen does not.',
    point: '4.6',
  },
  {
    key: 'tags',
    label: 'Tag registry',
    summary: 'Every tag with how many tickets carry it.',
    point: '3.11 / 9.15',
  },
  {
    key: 'audit',
    label: 'Audit log',
    summary:
      'Who granted a permission, revealed a contact, exported or reassigned. Written since April — with nowhere to read it.',
    point: '3.12 / 9.18',
  },
  {
    key: 'retention',
    label: 'Retention',
    summary: 'How long each kind of record is kept, and what deletes it.',
    point: 'SEC-25',
  },
];
