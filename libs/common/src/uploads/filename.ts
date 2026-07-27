/**
 * Client filename → display label (feature 016, FR-008).
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────────────────────────
 * It never produces a storage identity. The stored object's key is system-generated
 * (`{account_id}/{purpose}/{uuid}`), so a hostile filename has nothing to influence — this function
 * exists only so a human sees "receipt.pdf" instead of a UUID. That separation is the requirement;
 * sanitising a name and then using it as a path would satisfy the letter of FR-008 and none of it.
 *
 * ── Three separate hazards, deliberately handled together ────────────────────────────────────────
 * 1. Path traversal — only the last segment of a `/` or `\` path survives, and a segment that is
 *    only dots is dropped. Defence in depth: this value is not a path, but a future reader might
 *    treat it as one.
 * 2. HEADER INJECTION — the label is sent in `Content-Disposition`. A CR, LF or `"` in a filename
 *    can break out of the quoted string and forge a header, so control characters and quotes are
 *    removed rather than escaped. Escaping is one careless `JSON.stringify` away from being undone.
 * 3. Length — a 4 000-character name is a client bug or a probe. Capped, keeping the extension,
 *    because the extension is the part a human actually reads.
 *
 * The result can still be PII (`john_smith_passport.jpg`) — it is stored data like any other field
 * and MUST NOT be logged (FR-020 / SEC-26). Sanitised is not the same as safe to print.
 */

/** Longest label we keep. Generous for display, far below anything that stresses a header. */
const MAX_LENGTH = 120;
/** Longest suffix still treated as an extension worth preserving when truncating. */
const MAX_EXTENSION = 16;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
/** Quote and backslash: both can break out of a quoted `Content-Disposition` value. */
const HEADER_HOSTILE = /["\\]/g;

/**
 * A safe display label for `filename`, or `null` when nothing usable remains.
 *
 * `null` is a normal outcome, not an error: a file with no usable name is stored with no display
 * name. It is never replaced with a placeholder, because a made-up name is indistinguishable from
 * a real one to everybody downstream.
 */
export function toDisplayLabel(filename: string | undefined | null): string | null {
  if (typeof filename !== 'string') return null;

  // Last path segment only — handles POSIX and Windows paths, and `../../etc/passwd` alike.
  const segments = filename.split(/[\\/]/);
  let name = segments[segments.length - 1] ?? '';

  name = name.replace(CONTROL_CHARS, '').replace(HEADER_HOSTILE, '').trim();

  // A segment made only of dots (`.`, `..`) carries no name, only traversal meaning.
  if (/^\.+$/.test(name)) return null;
  if (name.length === 0) return null;

  if (name.length > MAX_LENGTH) name = truncateKeepingExtension(name);

  // Truncation can leave a trailing separator-ish remnant; a final trim keeps the label tidy.
  name = name.trim();
  return name.length > 0 ? name : null;
}

function truncateKeepingExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  // `dot > 0` so a dotfile (".env") is not read as an empty stem plus an extension.
  const ext = dot > 0 ? name.slice(dot) : '';
  if (ext.length === 0 || ext.length > MAX_EXTENSION) return name.slice(0, MAX_LENGTH);
  return name.slice(0, MAX_LENGTH - ext.length) + ext;
}
