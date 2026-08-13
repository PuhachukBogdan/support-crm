/**
 * Deriving the conversation's title — the window, the freeze, and the fallback
 * (feature 023, roadmap 4.18 — R10 / U8 / U9 / FR-014…FR-021). **Pure**: no database, no clock, no I/O.
 *
 * The caller supplies the before-state and the facts about the message being written; this decides
 * what (if anything) changes. Keeping it pure is what makes the window rules testable at their
 * boundaries — every interesting case here is an off-by-one on "which message closed it".
 *
 * ── The window, and the two states of `subject_source` ───────────────────────────────────────────
 *   subject_source = null    → the window is OPEN. `subject` may already hold a candidate.
 *   subject_source = 'auto'  → CLOSED by us. No automated writer touches it again (FR-018).
 *   subject_source = 'manual'→ CLOSED by a person. Nothing automated touches it, ever (FR-022).
 *   subject_source = 'source'→ ⭐ Feature 033: CLOSED BY THE SOURCE ITSELF. An email's `Subject` header
 *                              IS the title (FR-028) — the customer already named their own ticket, and
 *                              our derivation must never overwrite it. The window is closed at the
 *                              moment of creation, so nothing here ever sees such a conversation open.
 *
 * ⚠️ `'source'` is a THIRD value rather than a reuse of `'manual'`, and the distinction is not
 * decoration: `manual` asserts that a person in this system typed the title, which would be false, and
 * would put an agent's name on a customer's words in any later report that reads the column. All three
 * are equally truthy, which is all the freeze itself needs.
 *
 * The window closes at whichever comes first (FR-018):
 *   · the customer's 3rd message,
 *   · the first PUBLIC staff reply,
 *   · 10 minutes after creation — swept elsewhere (`subject.sweep.ts`, research R5).
 *
 * ── First substantive message wins, and that is what keeps this cheap ────────────────────────────
 * A candidate is chosen the moment a substantive customer message arrives, and a later one never
 * replaces it. So the write path never has to re-read earlier message BODIES to decide a title — the
 * decision is made once, incrementally, from the message already in hand.
 *
 * ── The fallback stores NULL, not the dash — a deliberate reading of FR-019 ──────────────────────
 * FR-019 says the title falls back to "the canonical no-value marker together with the topic when
 * known". The marker itself (`—`) is a **design-system rule** (ADR 0044: *"a single canonical token in
 * the design system"*), not a value: storing the glyph would put a rendering decision in the database,
 * make it sortable and searchable as if it were content, and strand every row the day the token
 * changes. So on a fallback close we store the **topic when there is one and NULL when there is not**,
 * and the UI renders NULL as `—` exactly as it does for every other absent value.
 *
 * Nothing is lost, because `subject_source` carries the part that matters: `auto` + `subject = null`
 * means "we looked and the customer never said anything usable", which is distinguishable from
 * `subject_source = null` ("still listening"). A bare NULL with no source would not be.
 */
import { isSubstantive } from './substantive';

/** Bounded so a 4 000-character opener cannot become a title (FR-019's "never a fragment" applies to the CUT, not the cap). */
export const MAX_SUBJECT_LENGTH = 120;

/** The attachment kinds a title may name. Never the file name (FR-017 / SEC-26). */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document' | 'file';

/**
 * `subject_source` values. `null` is a further state — the window is still open — and is not one of these.
 *
 * ⚠️ Only `auto` and `manual` are ever WRITTEN by this module and the rename path. `source` is written
 * once, at creation, by channel intake for a source-given title (FR-028); it appears in this type so the
 * vocabulary stays in one place, and so a reader of the column knows the third value exists.
 */
export type SubjectSource = 'auto' | 'manual' | 'source';

export interface SubjectBefore {
  subject: string | null;
  subject_source: string | null;
  /** The conversation's topic, when classification has produced one. Usually null today. */
  category: string | null;
}

export interface SubjectMessageFacts {
  authorType: 'operator' | 'player' | 'system';
  isPrivate: boolean;
  body: string;
  /** Derived by the caller from the already-described uploads — never a file name. */
  attachmentKind: AttachmentKind | null;
  /**
   * How many CUSTOMER messages this conversation now has, **including this one**.
   * Only read when the author is the customer; the caller may pass 0 otherwise.
   */
  playerMessageCount: number;
}

/** What the caller must write. `null` means "nothing changes" — the overwhelmingly common case. */
export interface SubjectChange {
  subject?: string | null;
  subject_source?: SubjectSource;
}

/** The customer's 3rd message closes the window (FR-018). */
export const CLOSING_PLAYER_MESSAGE_COUNT = 3;

/**
 * Map a content type to the kind a title may name.
 *
 * Deliberately coarse. The point of FR-017 is that a customer who opens with a screenshot and no
 * words still gets a scannable row — "image" does that; "image/png" is noise and a file name is a
 * leak.
 */
export function attachmentKindOf(contentType: string | null | undefined): AttachmentKind {
  const type = (contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (
    type === 'application/pdf' ||
    type.startsWith('text/') ||
    type.includes('word') ||
    type.includes('spreadsheet') ||
    type.includes('excel') ||
    type.includes('presentation') ||
    type.includes('opendocument')
  ) {
    return 'document';
  }
  return 'file';
}

/**
 * Collapse whitespace and cut at a WORD boundary (FR-019: never a mid-word fragment).
 *
 * The cut looks for the last separator at or before the cap. When a single token is longer than the
 * cap — a pasted URL, a transaction id — there is no boundary to cut at, so it is cut hard: a title
 * that is one 400-character token is not a title, and the alternative (dropping it entirely) loses
 * the only thing the customer said.
 */
export function toTitle(raw: string): string {
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (text.length <= MAX_SUBJECT_LENGTH) return text;

  const window = text.slice(0, MAX_SUBJECT_LENGTH + 1);
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace <= 0) return text.slice(0, MAX_SUBJECT_LENGTH);
  return window.slice(0, lastSpace).trimEnd();
}

/** An attachment-only opener yields kind + topic. Never the file name (FR-017). */
export function attachmentTitle(kind: AttachmentKind, category: string | null): string {
  return category ? `${kind} · ${category}` : kind;
}

/**
 * Decide what the incoming message does to the title. Returns `null` when nothing changes.
 *
 * Order matters and is the whole rule: the freeze is checked FIRST, so no later branch can reach a
 * conversation whose title a person set.
 */
export function decideSubject(
  before: SubjectBefore,
  message: SubjectMessageFacts,
): SubjectChange | null {
  // FR-018 / FR-022 — closed is closed. `manual` and `auto` are both terminal for automated writers.
  if (before.subject_source !== null) return null;

  // A private note and a system entry are inert here, by the same rule the contact stamp and the SLA
  // clock already use (`message/contact-stamp.ts`). Three definitions of "the customer spoke" would
  // drift, and the drift is invisible until a card, a report and a title disagree.
  if (message.isPrivate || message.authorType === 'system') return null;

  if (message.authorType === 'operator') {
    // The first PUBLIC staff reply closes the window with whatever we have (FR-018).
    return close(before.subject, before.category);
  }

  // ── The customer spoke ──────────────────────────────────────────────────────────────────────────
  const candidate = before.subject ?? candidateFrom(message, before.category);
  const isClosing = message.playerMessageCount >= CLOSING_PLAYER_MESSAGE_COUNT;

  if (isClosing) return close(candidate, before.category);
  if (candidate !== null && candidate !== before.subject) return { subject: candidate };
  return null;
}

/**
 * The candidate this message offers, or null.
 *
 * The attachment branch is checked only when the text is not substantive: a screenshot WITH a real
 * question is a real question, and naming it "image" would throw away the better title.
 */
function candidateFrom(message: SubjectMessageFacts, category: string | null): string | null {
  if (isSubstantive(message.body)) return toTitle(message.body);
  if (message.attachmentKind) return attachmentTitle(message.attachmentKind, category);
  return null;
}

/**
 * Close the window. `subject_source` becomes `auto` either way — the window is closed whether or not
 * anything usable arrived, so nothing re-opens it (data-model §4).
 */
function close(candidate: string | null, category: string | null): SubjectChange {
  return { subject: candidate ?? category ?? null, subject_source: 'auto' };
}
