/**
 * The alphabet of the emailed one-time code — **one source, two readers.**
 *
 * It is deliberately unambiguous: no `0`/`O`, no `1`/`I`, so a code read off a screen and typed by
 * hand cannot be mistyped in the one way a person cannot see. The browser leans on exactly this
 * property to normalise a pasted code (`web/src/lib/otp-code.ts`): upper-casing and stripping
 * whitespace can only turn an invalid string into a valid one, never a valid one into something else.
 *
 * ⚠️ It lives in its own file because it now has a SECOND reader. The generator picks characters
 * from it (`otp.service.ts`) and the configuration gate validates a fixed code against it
 * (`config.ts`) — and `config.ts` cannot import from `otp.service.ts`, which imports the config.
 * Two copies of this string would be two things to keep in agreement, and the failure would be
 * silent: a configured code containing a letter the generator never produces is refused by the
 * server while looking perfectly correct to whoever set it.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Matches a string made only of {@link CODE_ALPHABET} characters (at least one). */
export const CODE_ALPHABET_RE = new RegExp(`^[${CODE_ALPHABET}]+$`);
