/**
 * Remove comments while PRESERVING string literals — shared infrastructure for structural guards.
 *
 * ── Why this exists as one function rather than per-guard ────────────────────────────────────────
 * This product writes guards that ban a token from the SOURCE: "no code reads `x-actor-brands`", "no
 * preferences path reads a permission set", "nothing outside the catalogue defines a default". Every
 * one of them hits the same wall immediately, and it caught two guards on the same afternoon:
 *
 *   > The comment that documents a removal legitimately NAMES the removed thing.
 *
 * A retraction block saying "`mayAccessBrand` was removed, brand is not a permission" is the single
 * most valuable line for whoever comes next — and a token ban would force its deletion. So the
 * detector for this whole class of guard is **strip comments, then match**, and this is that step.
 *
 * ── Why a walk rather than a regex ───────────────────────────────────────────────────────────────
 * Deleting from `//` to end-of-line with a regex truncates any line containing `//` inside a string
 * — a URL, a path, a header value — and a truncated line is a token the guard silently stops seeing.
 * A false pass in a guard is worse than no guard, so this walks the source and keeps string literals
 * intact.
 *
 * ⚠️ Regex literals containing a quote character can still confuse the walk. That direction produces
 * a FALSE POSITIVE (a flagged file to look at), never a false pass, which is the safe way to be
 * wrong. Anything more would be a parser, and a guard is not worth a parser.
 *
 * ── Testing note, learned the hard way ───────────────────────────────────────────────────────────
 * A guard's self-check must exercise the PIPELINE (strip, then match), not the matcher alone. The
 * `no-direct-network` guard's first self-check tested its regex while its detector was the pipeline,
 * so it proved the wrong thing and passed.
 */
export function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
