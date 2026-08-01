/**
 * Is a customer message substantive enough to become the conversation's title?
 * (feature 023, roadmap 4.18 — R10 / U8). Pure: no database, no clock, no I/O.
 *
 * ── The problem being solved ─────────────────────────────────────────────────────────────────────
 * Their Zendesk fills a chat's subject from the first message, literally. So ticket lists read as
 * *"привет"*, *"???"*, a single emoji, or half a sentence — and an agent cannot triage without
 * opening every row. The fix is not "clean up the string": it is to *skip* messages that carry no
 * topic and wait for one that does.
 *
 * ── The rule (U8), and why all three conditions are required ─────────────────────────────────────
 *   ≥ 15 characters   — a greeting is short.
 *   ≥ 2 words         — 15 characters of one repeated word passes length and says nothing.
 *   not filler        — "buenas tardes" is long enough and has two words.
 * Any two of the three let something through; that is why the spec tests each boundary separately.
 *
 * ── No language detection, deliberately (research R6) ────────────────────────────────────────────
 * This product has no language signal: `Conversation` carries none, and the platform's
 * `registrationLanguage` sits behind credentials we do not have. So the filler list is matched as a
 * UNION across every seeded language rather than a language-selected subset. A greeting in any of
 * them is filtered regardless of which language the conversation is in — correct by construction,
 * with no dependency and no new failure mode.
 *
 * That also makes "produce the title in the customer's language" (FR-021) free: the title is the
 * customer's own words, copied. There is no generation step and nothing to translate.
 */
import { FILLER_TOKENS } from './filler.data';

/** Unicode-aware: strips punctuation and symbols, keeps letters, numbers and separators. */
const normalise = (raw: string): string =>
  raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const FILLER = new Set(FILLER_TOKENS.map(normalise));

export const MIN_SUBSTANTIVE_CHARS = 15;
export const MIN_SUBSTANTIVE_WORDS = 2;

/**
 * `true` when this text carries a topic worth putting in a list.
 *
 * Length is measured on the ORIGINAL trimmed text, not the normalised form: stripping punctuation to
 * decide length would let "?????????????????" through on a technicality.
 */
export function isSubstantive(raw: string | null | undefined): boolean {
  if (!raw) return false;

  const trimmed = raw.trim();
  if (trimmed.length < MIN_SUBSTANTIVE_CHARS) return false;

  const normalised = normalise(trimmed);
  if (!normalised) return false; // emoji-only / punctuation-only collapses to nothing

  if (FILLER.has(normalised)) return false;

  const words = normalised.split(' ').filter(Boolean);
  if (words.length < MIN_SUBSTANTIVE_WORDS) return false;

  // Every word being the same token is one word repeated, not two words.
  if (new Set(words).size < MIN_SUBSTANTIVE_WORDS) return false;

  return true;
}
