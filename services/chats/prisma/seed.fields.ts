import { SEED_ACCOUNT_ID } from '@crm/common';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the team's OWN ticket-field taxonomy, seeded.
 *
 * ── Where these values come from ─────────────────────────────────────────────────────────────────
 * The operator's screenshots of every Zendesk field page (12.08.2026, «Fields из Зена.docx» — 76
 * frames). Transcribed value-for-value into
 * `cowork/_archive/zendesk-capture-raw/ticket-field-values.md`, which is the source of truth for
 * this file: **if a value here disagrees with that transcript, the transcript is right.** The
 * earlier seed carried four or five invented placeholders per list (Brazil, Provider error, …) —
 * they are gone; every value below was read off their screen.
 *
 * ⚠️ **Their spellings are kept EXACTLY**, typos included: «Withdrawal Satus», «Oher bonus info»,
 * «Client cant log in», «Order Vs deposit missmatch», «Sportbooks», «Poduct», «Declined::Other».
 * Normalising them would make this fixture disagree with the system it mirrors, and the whole point
 * of a closed value list is that two systems can be compared. The one exception is a DOUBLE space
 * («VIP Anniversary /  Birthday» in their tag) — an invisible difference that no reader could
 * reproduce, so it is a single space here and recorded in the transcript.
 *
 * ⚠️ **A SEED, not a migration.** These are the account's starting rows; the operator edits them on
 * `/admin/fields` and a re-seed must not overwrite what he has since decided — the runner's
 * `update` therefore carries labels/order and never `active` (the statuses rule, third instance).
 *
 * ── What is deliberately NOT wired, and why ─────────────────────────────────────────────────────
 * Zendesk expresses the cascade as separate per-parent fields, and the screenshots give the field
 * NAMES but never say which parent VALUE opens them. Where the name matches a parent value
 * one-to-one (exactly, or through their own typo) the condition is encoded. Where it does not, the
 * field is seeded but left UNCONDITIONED rather than guessed:
 *   · «Form L2 - Cashback Bonus» / «Deposit Bonus %» / «Free bet Bonus» / «Free Spins Bonus» —
 *     these look like children of the BONUS KIND, not of an L1 topic; which value opens which is
 *     not on any frame.
 *   · the generic «Form L2» (26 values) and «Form L3» (8 values) — catch-alls whose parent is
 *     unknowable from a screenshot.
 * They are listed in the block's report so the operator can say the word; wiring one is one row.
 */

const A = SEED_ACCOUNT_ID;

// ── option sets ──────────────────────────────────────────────────────────────────────────────────
//
// `slug` is the id stem; ids are `seed-oset-<slug>` / `seed-oval-<slug>-<n>`. Ids are DERIVED
// rather than hand-written so that a value added to a list needs one edit, not two — and the value
// STRING is what a conversation stores, so an id change is invisible to stored data.

interface SetSpec {
  slug: string;
  name: string;
  values: string[];
}

const SETS: SetSpec[] = [
  // ── the fields every topical form carries ──────────────────────────────────────────────────────
  { slug: 'countries', name: 'Countries', values: ['Chile', 'Argentina', 'Mexico', 'Colombia', 'Other Countries', 'Unknown'] },
  { slug: 'contact-type', name: 'Type of contact', values: ['Regular', 'Ghost Contact', 'Bot Managed', 'TEST'] },
  { slug: 'user-level', name: 'User level', values: ['Regular', 'VIP', 'Unknown', 'Ghost Contact', 'TEST'] },
  // ── payments ───────────────────────────────────────────────────────────────────────────────────
  { slug: 'psp', name: 'PSP', values: ['D24/Gateway', 'Betterbro (Src H2H)', 'Manitist', 'Paypaga', 'HG Cash', 'Unknown'] },
  { slug: 'payment-gateway', name: 'Payment gateway', values: ['Directa24', 'PayCord', 'Pay4Fun', 'PIX', 'Others'] },
  { slug: 'bonus-type', name: 'Bonus name/type', values: ['Free spin', '% Deposit', 'Cashback', 'Sorry bonus', 'Free bet', 'Daily bonus', 'Bonus not informed by customer', 'Other'] },
  // ── the L1 topic of each form (the sub-category source) ────────────────────────────────────────
  { slug: 'l1-deposits', name: 'Deposits topics', values: ['How to deposit', 'Payment methods offered', 'Deposit status', 'No deposit order created', 'Deposit Delay', 'General info', 'PSP Ticket', 'Other'] },
  { slug: 'l1-withdrawal', name: 'Withdrawal topics', values: ['How to withdrawal', 'Withdrawal Satus', 'Withdrawal Delay', 'Cancel Request', 'Unable to Withdraw', 'General Info', 'Other'] },
  { slug: 'l1-account', name: 'Account topics', values: ['Request to close account', 'Request to re-open account', 'Duplicated account', 'Change personal details', 'Update phone number', 'Update email', 'Balance info', 'Password reset', 'Account restrictions', 'General questions', 'Delete data request', 'Email not found', 'Other'] },
  { slug: 'l1-general', name: 'General topics', values: ['General questions', 'How to register', 'How to play', 'Refund request', 'More info', 'Terms and Conditions', 'Privacy policy', 'Navigation help', 'Fairplay RNG', 'Collaboration', 'Other'] },
  { slug: 'l1-issues', name: 'Issues topics', values: ['Website', 'Promotions', 'Deposits', 'Withdrawal', 'Account', 'Sportbooks', 'Provider Issue', 'Other'] },
  { slug: 'l1-product', name: 'Product topics', values: ['Casino General Info', 'Slot General Info', 'Live casino info', 'Games info', 'Product suggestion', 'Other'] },
  { slug: 'l1-promotions', name: 'Promotions topics', values: ['Retracted Bonus', 'Withdrawal unavailable by Bonus Terms', 'Balance locked', 'Cancel Request', 'General info', 'Loyalty Program (Level program) Info', 'Bonus Request', 'Sport Bonus', 'Promo code', 'Other'] },
  { slug: 'l1-verification', name: 'Verification topics', values: ['Email verification', 'Phone verification', 'How to verify', 'Verification status', 'User unable to verify account', 'Risk Verification', 'Other'] },
  { slug: 'l1-vip-topics', name: 'VIP topics', values: ['VIP Perks', 'VIP Follow Up'] },
  // ⓘ The Sportsbooks form has no «Form L1 - Sportsbooks» page in the capture; «Level 2 -
  // Sportsbooks» carries exactly the topic-shaped values, so it serves as that form's topic.
  { slug: 'l1-sportsbooks', name: 'Sportsbooks topics', values: ['Sportbet General Info', 'Sportsbook General Info', 'Claim of bet not settled correctly', 'Sportbet not available', 'Other'] },
  // ── L2, wired where the field NAME matches a parent value ──────────────────────────────────────
  { slug: 'l2-deposit-status', name: 'Deposit status', values: ['Approved', 'Pending', 'Declined'] },
  { slug: 'l2-deposits-delay', name: 'Deposit delay reasons', values: ['PSP delay', 'Order Vs deposit missmatch', 'Order created post deposit', 'Unknown'] },
  { slug: 'l2-withdrawal-status', name: 'Withdrawal status', values: ['Pending', 'Declined', 'Approved'] },
  { slug: 'l2-unable-to-withdraw', name: 'Unable to withdraw reasons', values: ['Incomplete verification', 'Withdrawal limit'] },
  { slug: 'l2-account-restrictions', name: 'Account restrictions', values: ['Bonus Abuser / Casino', 'Bonus Abuser / Sports', 'Bonus hunting', 'Billing antifraud', 'Risk', 'Duplicated from another operator', 'Underage', 'Other'] },
  { slug: 'l2-close-account', name: 'Request to close account reasons', values: ['Gambling addiction', 'Request to self exclude', 'Incorrect Country/currency'] },
  { slug: 'l2-password-reset', name: 'Password reset', values: ['How to reset password', 'Password Recovery Assistance'] },
  { slug: 'l2-verification-status', name: 'Verification status', values: ['Completed', 'Declined', 'Requested'] },
  { slug: 'l2-retracted-bonus', name: 'Retracted bonus', values: ['Expired Bonus', 'Max Limit bonus winning'] },
  { slug: 'l2-sport-bonus', name: 'Sport bonus', values: ['Bonus mechanic (50/50)', 'Terms and conditions'] },
  { slug: 'l2-promo-general', name: 'Promotions general info', values: ['Terms and conditions', 'Oher bonus info'] },
  { slug: 'l2-vip-perks', name: 'VIP perks', values: ['VIP Exclusive Promo', 'VIP Anniversary / Birthday', 'VIP Bonus Request', 'VIP Preferences'] },
  { slug: 'l2-vip-follow-up', name: 'VIP follow up', values: ['Missed Call', 'Prospect Outreach'] },
  { slug: 'l2-issues-website', name: 'Issues — website', values: ['Login Problems', 'Website/Platform Errors', 'Game Not Loading / Crashing', 'Performance/Slow Loading', 'Error in Game', 'UI Issues', 'Other'] },
  { slug: 'l2-issues-promotions', name: 'Issues — promotions', values: ['Bonus Not Triggering', 'Incorrect bonus offer sent', 'Bonus error', 'Other'] },
  { slug: 'l2-issues-deposits', name: 'Issues — deposits', values: ['Deposit Payment Error', 'Other'] },
  { slug: 'l2-issues-withdrawal', name: 'Issues — withdrawal', values: ['Withdrawal Payment Error', 'Other'] },
  { slug: 'l2-issues-account', name: 'Issues — account', values: ['Incorrect Balance / Funds Not Updated', 'Other'] },
  { slug: 'l2-issues-sportbooks', name: 'Issues — sportbooks', values: ['Bet not settled or settled incorrectly', 'Other'] },
  // ── L3 ─────────────────────────────────────────────────────────────────────────────────────────
  { slug: 'l3-deposit-declined', name: 'Deposit declined reasons', values: ['Timeout', 'Declined by bank', 'General declined', 'Antifraud declined', 'Too many requests', 'Cancelled by Customer', 'Other'] },
  { slug: 'l3-ws-declined', name: 'Withdrawal declined reasons', values: ['Timeout', 'Declined by bank', '70% not wagered', 'General declined', 'Antifraud declined', 'Too many requests', 'Other'] },
  { slug: 'l3-ws-pending', name: 'Withdrawal pending reasons', values: ['By provider', 'Awaiting from bank'] },
  // ── other CUSTOM lists from the capture (not part of the cascade) ──────────────────────────────
  //
  // ⚠️ Their STANDARD fields (Approval status · Channel group · Required tasks · Resolution tier ·
  // Resolution type · Priority · Type · Ticket status) are deliberately NOT here: each belongs to a
  // product feature of its own (approvals, routing, our own status catalogue — feature 032), and
  // seeding them as custom fields would create a second place that answers the same question.
  { slug: 'type-of-issue', name: 'Type of issue', values: ['Technical', 'Non Technical'] },
  { slug: 'topic', name: 'Topic', values: ['Deposit::Delay::Card', 'Account ban', 'Activation', 'BetGames/TVBet', 'Bets', 'Betting Shops', 'Bonus Request', 'Casino', 'Casino Live', 'Correction', 'Customer Support', 'Data Recovery', 'Deposit', 'Empty', 'Esports', 'Gamification', 'General Questions', 'Instant Games', 'Legal Questions', 'Mobile Application', 'Other', 'Poduct', 'Promotions', 'Repeated Request', 'Responsible Gambling', 'Spam', 'Sports Content', 'Top Parlay', 'Verification', 'Video broadcast', 'VIP', 'VIP Bets', 'VIP Promotions', 'Virtual Sports', 'Website Complaints', 'Withdrawal', 'X-pass'] },
];

// ── field definitions ────────────────────────────────────────────────────────────────────────────
//
// `required` mirrors THEIR «Required to solve a ticket» checkbox exactly. It gates the solve, never
// the editing (D4) — and it is one toggle on `/admin/fields` if the operator wants it relaxed.

interface FieldSpec {
  key: string;
  label: string;
  type: 'dropdown' | 'text' | 'numeric' | 'multiline';
  required?: boolean;
  set?: string; // option-set slug; required ⟺ type === 'dropdown'
}

const FIELDS: FieldSpec[] = [
  // common
  { key: 'country', label: 'Country', type: 'dropdown', required: true, set: 'countries' },
  { key: 'type_of_contact', label: 'Type of contact', type: 'dropdown', required: true, set: 'contact-type' },
  { key: 'user_level', label: 'User Level', type: 'dropdown', required: true, set: 'user-level' },
  { key: 'comments', label: 'Comments', type: 'multiline' },
  // payments
  { key: 'psp', label: 'PSP', type: 'dropdown', required: true, set: 'psp' },
  { key: 'payment_gateway', label: 'Payment Gateway', type: 'dropdown', required: true, set: 'payment-gateway' },
  { key: 'deposit_amount', label: 'Deposit Amount', type: 'numeric', required: true },
  { key: 'transaction_id', label: 'Transaction ID', type: 'text', required: true },
  { key: 'external_id_psp', label: 'External ID (PSP ID)', type: 'text', required: true },
  { key: 'payment_date', label: 'Payment Date', type: 'text', required: true },
  { key: 'bonus_name_type', label: 'Bonus name/type', type: 'dropdown', required: true, set: 'bonus-type' },
  // L1 — one per form, each its form's sub-category source
  { key: 'l1_deposits', label: 'Form L1 - Deposits', type: 'dropdown', required: true, set: 'l1-deposits' },
  { key: 'l1_withdrawal', label: 'Form L1 - Withdrawal', type: 'dropdown', required: true, set: 'l1-withdrawal' },
  { key: 'l1_account', label: 'Form L1 - Account', type: 'dropdown', required: true, set: 'l1-account' },
  { key: 'l1_general', label: 'Form L1 - General', type: 'dropdown', required: true, set: 'l1-general' },
  { key: 'l1_issues', label: 'Form L1 - Issues', type: 'dropdown', required: true, set: 'l1-issues' },
  { key: 'l1_product', label: 'Form L1 - Product', type: 'dropdown', required: true, set: 'l1-product' },
  { key: 'l1_promotions', label: 'Form L1 - Promotions and bonus', type: 'dropdown', required: true, set: 'l1-promotions' },
  { key: 'l1_verification', label: 'Form L1 - Verification', type: 'dropdown', required: true, set: 'l1-verification' },
  { key: 'l1_vip_topics', label: 'Form L1 - VIP Topics', type: 'dropdown', required: true, set: 'l1-vip-topics' },
  { key: 'l1_sportsbooks', label: 'Level 2 - Sportsbooks', type: 'dropdown', required: true, set: 'l1-sportsbooks' },
  // L2
  { key: 'l2_deposit_status', label: 'Form L2 - Deposit status', type: 'dropdown', required: true, set: 'l2-deposit-status' },
  { key: 'l2_deposits_delay', label: 'L2 - Deposits Delay', type: 'dropdown', required: true, set: 'l2-deposits-delay' },
  { key: 'l2_withdrawal_status', label: 'Form L2 - Withdrawal Status', type: 'dropdown', required: true, set: 'l2-withdrawal-status' },
  { key: 'l2_unable_to_withdraw', label: 'Level 2 - Unable to Withdraw', type: 'dropdown', set: 'l2-unable-to-withdraw' },
  { key: 'l2_account_restrictions', label: 'Form L2 - Account restrictions', type: 'dropdown', set: 'l2-account-restrictions' },
  { key: 'l2_close_account', label: 'Form L2 - Request to close account', type: 'dropdown', set: 'l2-close-account' },
  { key: 'l2_password_reset', label: 'Form L2 - Password Reset', type: 'dropdown', set: 'l2-password-reset' },
  { key: 'l2_verification_status', label: 'Level 2 - Verification Status', type: 'dropdown', required: true, set: 'l2-verification-status' },
  { key: 'l2_retracted_bonus', label: 'Form L2 - Retracted Bonus', type: 'dropdown', required: true, set: 'l2-retracted-bonus' },
  { key: 'l2_sport_bonus', label: 'Level 2 - Sport Bonus', type: 'dropdown', set: 'l2-sport-bonus' },
  { key: 'l2_promo_general', label: 'Form L2 - General info', type: 'dropdown', set: 'l2-promo-general' },
  { key: 'l2_vip_perks', label: 'Form L2 - VIP Perks', type: 'dropdown', required: true, set: 'l2-vip-perks' },
  { key: 'l2_vip_follow_up', label: 'Form L2 - VIP Follow Up', type: 'dropdown', required: true, set: 'l2-vip-follow-up' },
  { key: 'l2_issues_website', label: 'Issues L2 - Website', type: 'dropdown', required: true, set: 'l2-issues-website' },
  { key: 'l2_issues_promotions', label: 'Issues L2 - Promotions', type: 'dropdown', required: true, set: 'l2-issues-promotions' },
  { key: 'l2_issues_deposits', label: 'Issues L2 - Deposits', type: 'dropdown', required: true, set: 'l2-issues-deposits' },
  { key: 'l2_issues_withdrawal', label: 'Issues L2 - Withdrawal', type: 'dropdown', required: true, set: 'l2-issues-withdrawal' },
  { key: 'l2_issues_account', label: 'Issues L2 - Account', type: 'dropdown', set: 'l2-issues-account' },
  { key: 'l2_issues_sportbooks', label: 'Issues L2 - Sportbooks', type: 'dropdown', required: true, set: 'l2-issues-sportbooks' },
  // L3
  { key: 'l3_deposit_declined', label: 'Level 3 - Deposit/Declined', type: 'dropdown', set: 'l3-deposit-declined' },
  { key: 'l3_ws_declined', label: 'Form L3 - WS Declined', type: 'dropdown', required: true, set: 'l3-ws-declined' },
  { key: 'l3_ws_pending', label: 'Form L3 - WS Pending', type: 'dropdown', required: true, set: 'l3-ws-pending' },
  // Captured custom fields that sit on NO form here — see the FORMS note: the only frame that shows
  // a real form's composition is `conversation/032` (Deposits), so these wait in the catalogue for
  // the operator to place them, which is one drag on `/admin/fields`.
  { key: 'type_of_issue', label: 'Type of Issue', type: 'dropdown', required: true, set: 'type-of-issue' },
  { key: 'topic', label: 'Topic', type: 'dropdown', required: true, set: 'topic' },
  { key: 'client_name', label: 'Client name', type: 'text' },
  { key: 'user_description', label: 'User Description', type: 'multiline' },
];

// ── forms ────────────────────────────────────────────────────────────────────────────────────────
//
// One entry per row of the ticket's left column, in order. `cond` is [parent field key, value] —
// encoded ONLY where the child field's NAME names a parent value (see the header). `source: true`
// marks the dropdown whose value becomes the conversation's `sub_category`.

interface EntrySpec {
  field: string;
  cond?: [string, string];
  source?: boolean;
}
interface FormSpec {
  key: string;
  name: string;
  category?: string;
  entries: EntrySpec[];
}

/**
 * ⚠️ **A form's composition is evidence, not inference.** The ONE frame that shows a real form's
 * left column is `conversation/032` (Deposits): Country · Form L1 · Form L2 · Level 3 · PSP · Type
 * of contact · User Level. So a form here carries its L1 cascade plus these three globals, and
 * NOTHING else — the payment details (Deposit Amount, Transaction ID, External ID, Payment Date,
 * Payment Gateway), Bonus name/type, Type of Issue, Topic, Client name and User Description are
 * seeded as DEFINITIONS on no form. A first draft put the payment ones on Deposits «by meaning»;
 * the frame does not show them there, and a guess that over-gates the solve is worse than an empty
 * slot the operator fills with one drag.
 */
const COMMON: EntrySpec[] = [
  { field: 'country' },
  { field: 'type_of_contact' },
  { field: 'user_level' },
];

const FORMS: FormSpec[] = [
  // The two neutral forms carry no category: choosing them must not re-file the ticket (D2).
  { key: 'default', name: 'Default', entries: [] },
  { key: 'ghost_contact', name: 'Ghost Contact', entries: [{ field: 'type_of_contact' }] },
  {
    // ⭐ Frame `conversation/032`, in its own order: Country first, then the cascade, then PSP and
    // the two audience fields. This form is the one composition the capture actually shows.
    key: 'deposits',
    name: 'Deposits',
    category: 'Deposits',
    entries: [
      { field: 'country' },
      { field: 'l1_deposits', source: true },
      { field: 'l2_deposit_status', cond: ['l1_deposits', 'Deposit status'] },
      { field: 'l3_deposit_declined', cond: ['l2_deposit_status', 'Declined'] },
      { field: 'l2_deposits_delay', cond: ['l1_deposits', 'Deposit Delay'] },
      { field: 'psp' },
      { field: 'type_of_contact' },
      { field: 'user_level' },
    ],
  },
  {
    key: 'withdrawal',
    name: 'Withdrawal',
    category: 'Withdrawal',
    entries: [
      { field: 'l1_withdrawal', source: true },
      // ⚠️ «Withdrawal Satus» — their own typo in the L1 list; the condition must match the VALUE
      // as stored, not as it should have been spelled.
      { field: 'l2_withdrawal_status', cond: ['l1_withdrawal', 'Withdrawal Satus'] },
      { field: 'l3_ws_declined', cond: ['l2_withdrawal_status', 'Declined'] },
      { field: 'l3_ws_pending', cond: ['l2_withdrawal_status', 'Pending'] },
      { field: 'l2_unable_to_withdraw', cond: ['l1_withdrawal', 'Unable to Withdraw'] },
      { field: 'psp' },
      ...COMMON,
    ],
  },
  {
    key: 'account',
    name: 'Account',
    category: 'Account',
    entries: [
      { field: 'l1_account', source: true },
      { field: 'l2_close_account', cond: ['l1_account', 'Request to close account'] },
      { field: 'l2_account_restrictions', cond: ['l1_account', 'Account restrictions'] },
      { field: 'l2_password_reset', cond: ['l1_account', 'Password reset'] },
      ...COMMON,
    ],
  },
  {
    key: 'issues',
    name: 'Issues',
    category: 'Issues',
    entries: [
      { field: 'l1_issues', source: true },
      { field: 'l2_issues_website', cond: ['l1_issues', 'Website'] },
      { field: 'l2_issues_promotions', cond: ['l1_issues', 'Promotions'] },
      { field: 'l2_issues_deposits', cond: ['l1_issues', 'Deposits'] },
      { field: 'l2_issues_withdrawal', cond: ['l1_issues', 'Withdrawal'] },
      { field: 'l2_issues_account', cond: ['l1_issues', 'Account'] },
      { field: 'l2_issues_sportbooks', cond: ['l1_issues', 'Sportbooks'] },
      ...COMMON,
    ],
  },
  {
    key: 'verification',
    name: 'Verification',
    category: 'Verification',
    entries: [
      { field: 'l1_verification', source: true },
      { field: 'l2_verification_status', cond: ['l1_verification', 'Verification status'] },
      ...COMMON,
    ],
  },
  {
    key: 'promotions_and_bonus',
    name: 'Promotions and bonus',
    category: 'Promotions and bonus',
    entries: [
      { field: 'l1_promotions', source: true },
      { field: 'l2_retracted_bonus', cond: ['l1_promotions', 'Retracted Bonus'] },
      { field: 'l2_sport_bonus', cond: ['l1_promotions', 'Sport Bonus'] },
      { field: 'l2_promo_general', cond: ['l1_promotions', 'General info'] },
      ...COMMON,
    ],
  },
  {
    key: 'vip_topics',
    name: 'VIP Topics',
    category: 'VIP Topics',
    entries: [
      { field: 'l1_vip_topics', source: true },
      { field: 'l2_vip_perks', cond: ['l1_vip_topics', 'VIP Perks'] },
      { field: 'l2_vip_follow_up', cond: ['l1_vip_topics', 'VIP Follow Up'] },
      ...COMMON,
    ],
  },
  { key: 'general', name: 'General', category: 'General', entries: [{ field: 'l1_general', source: true }, ...COMMON] },
  { key: 'product', name: 'Product', category: 'Product', entries: [{ field: 'l1_product', source: true }, ...COMMON] },
  { key: 'sportsbooks', name: 'Sportsbooks', category: 'Sportsbooks', entries: [{ field: 'l1_sportsbooks', source: true }, ...COMMON] },
];

// ── expansion into seed rows ─────────────────────────────────────────────────────────────────────

const setId = (slug: string) => `seed-oset-${slug}`;
const fieldId = (key: string) => `seed-field-${key.replace(/_/g, '-')}`;
const formId = (key: string) => `seed-form-${key.replace(/_/g, '-')}`;

const bySlug = new Map(SETS.map((s) => [s.slug, s]));
const byFieldKey = new Map(FIELDS.map((f) => [f.key, f]));

// Fail LOUDLY at build time rather than writing a broken fixture: a dropdown without its set (or a
// set nobody references) is the shape the service would refuse anyway, one layer later.
for (const f of FIELDS) {
  const needsSet = f.type === 'dropdown';
  if (needsSet !== !!f.set) throw new Error(`seed.fields: ${f.key} — dropdown ⟺ option set`);
  if (f.set && !bySlug.has(f.set)) throw new Error(`seed.fields: ${f.key} names unknown set ${f.set}`);
}
for (const form of FORMS) {
  const keys = form.entries.map((e) => e.field);
  if (new Set(keys).size !== keys.length) throw new Error(`seed.fields: ${form.key} repeats a field`);
  if (form.entries.filter((e) => e.source).length > 1) throw new Error(`seed.fields: ${form.key} has two sources`);
  for (const e of form.entries) {
    const def = byFieldKey.get(e.field);
    if (!def) throw new Error(`seed.fields: ${form.key} names unknown field ${e.field}`);
    if (!e.cond) continue;
    const [parentKey, value] = e.cond;
    const parent = byFieldKey.get(parentKey);
    if (!parent || parent.type !== 'dropdown') throw new Error(`seed.fields: ${form.key}/${e.field} — parent must be a dropdown`);
    if (!keys.includes(parentKey)) throw new Error(`seed.fields: ${form.key}/${e.field} — parent not on the form`);
    // ⭐ The condition must name a value the parent's list actually holds — the check that catches
    // a typo the moment it is written instead of when an agent finds a field that never appears.
    if (!bySlug.get(parent.set!)!.values.includes(value)) {
      throw new Error(`seed.fields: ${form.key}/${e.field} — «${value}» is not in ${parent.set}`);
    }
  }
}

export const FIELD_SEED = {
  optionSets: SETS.map((s) => ({ id: setId(s.slug), account_id: A, name: s.name })),
  optionValues: SETS.flatMap((s) =>
    s.values.map((value, i) => ({
      id: `seed-oval-${s.slug}-${i + 1}`,
      account_id: A,
      option_set_id: setId(s.slug),
      value,
      order: i * 10,
      active: true,
    })),
  ),
  fieldDefinitions: FIELDS.map((f) => ({
    id: fieldId(f.key),
    account_id: A,
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required === true,
    // ⚠️ NOTHING is restricted at seed time — Q15's answer stands («по умолчанию ничего не
    // ограничено»). The mechanism ships; the operator flags what he wants withheld.
    restricted: false,
    option_set_id: f.set ? setId(f.set) : (null as string | null),
    brand_ids: [] as string[],
    active: true,
  })),
  forms: FORMS.map((form, i) => ({
    id: formId(form.key),
    account_id: A,
    key: form.key,
    name: form.name,
    category: (form.category ?? null) as string | null,
    active: true,
    order: i * 10,
  })),
  formFields: FORMS.flatMap((form) =>
    form.entries.map((e, i) => ({
      id: `seed-ff-${form.key.replace(/_/g, '-')}-${e.field.replace(/_/g, '-')}`,
      account_id: A,
      form_id: formId(form.key),
      field_id: fieldId(e.field),
      order: i * 10,
      condition_field_id: e.cond ? fieldId(e.cond[0]) : (null as string | null),
      condition_value: e.cond ? e.cond[1] : (null as string | null),
      is_subcategory_source: e.source === true,
    })),
  ),
};
