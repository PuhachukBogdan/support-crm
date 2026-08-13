import { API_PREFIX } from './gateway/http-port';

/**
 * How an upload id becomes something an `<img>` can load — in ONE place, on the data side of the seam.
 *
 * ── Why this file exists (W22) ───────────────────────────────────────────────────────────────────
 * The user menu needed to render an avatar, and building the URL inline made the SHELL import
 * `data/gateway/http-port`. `swap-point.test.ts` refused it, correctly: *"no screen depends on the
 * transport"* — a screen that knows the API prefix turns "swap the implementation" from one line into
 * a rewrite. The prefix is a transport fact; a screen only ever wants "the picture of this upload".
 *
 * ⚠️ It also closes a hole the guard could not see. `features/settings/profile-section.tsx` had been
 * importing the prefix directly since W19 and passed only because the scan covers `components/` and
 * `app/`, not `features/`. The same rule applies there; it now calls this instead. **The guard's
 * scope is the bug, not the excuse** — but widening the scan is a separate change from fixing the
 * one caller it would catch.
 *
 * ⭐ Always the derivative, never the original: feature 016 makes a 256 px thumb for every avatar at
 * ingest (`derivative: always`), so a 2 MB photo costs a rail icon nothing.
 */
export function uploadThumbUrl(uploadId: string): string {
  return `${API_PREFIX}/uploads/${encodeURIComponent(uploadId)}/thumb`;
}
