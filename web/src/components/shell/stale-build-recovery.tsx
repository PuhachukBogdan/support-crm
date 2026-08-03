'use client';

import { useEffect } from 'react';

/**
 * Recover a tab that was open across a deployment.
 *
 * ── The failure this exists for, observed 2026-08-02 ────────────────────────────────────────────
 * A person had the app open; the web container was rebuilt and restarted underneath them. Their tab
 * still held the previous build's JavaScript, so the first navigation to a route whose chunk was not
 * already loaded asked for `/_next/static/chunks/…-<old hash>.js`, which **no longer exists** — the
 * server answers 404. The router cannot complete the navigation, the route's `loading.tsx` skeleton
 * stays on screen, and it looks exactly like the product hanging. Nothing is wrong with the server:
 * SSR, RSC and the proxy all answer in tens of milliseconds.
 *
 * ⚠️ It is not a rare edge case — **every** deployment does this to every open tab, and the person
 * has no way to know that a hard reload is the fix.
 *
 * ── Why a reload, and why exactly one ───────────────────────────────────────────────────────────
 * A chunk that 404s cannot be retried into existence; the only recovery is to fetch the current
 * build's HTML. So: reload once, and mark it. If the very next load fails the same way the marker
 * stops us, because a reload loop is far worse than a visible error — it hides the real fault and
 * burns the person's tab. The marker expires so a *later* deployment can recover in its turn.
 *
 * ⛔ Deliberately narrow: it matches chunk/module-loading failures only. A blanket "reload on any
 * error" would paper over ordinary application bugs and make them unreportable.
 */
const MARKER = 'crm:stale-build-reload';
/** How long a marker suppresses another attempt. Long enough to break a loop, short enough that the
 *  next deployment is not left unrecoverable. */
const SUPPRESS_MS = 60_000;

export function isChunkLoadFailure(message: string): boolean {
  return /ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    message,
  );
}

export function StaleBuildRecovery() {
  useEffect(() => {
    // Getting here means the page loaded successfully, so any marker from a previous attempt has
    // done its job. Clearing it once it is old keeps the guard armed for the next deployment.
    try {
      const at = Number(window.sessionStorage.getItem(MARKER) ?? 0);
      if (at && Date.now() - at > SUPPRESS_MS) window.sessionStorage.removeItem(MARKER);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The guard degrades to "no
      // recovery", which is the behaviour we had before — never to a reload loop.
    }

    const recover = () => {
      try {
        const at = Number(window.sessionStorage.getItem(MARKER) ?? 0);
        if (at && Date.now() - at <= SUPPRESS_MS) return; // already tried; let the error surface
        window.sessionStorage.setItem(MARKER, String(Date.now()));
      } catch {
        return; // no storage ⇒ no loop protection ⇒ do not reload at all
      }
      window.location.reload();
    };

    const onError = (e: ErrorEvent) => {
      if (isChunkLoadFailure(e.message ?? '')) recover();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: string } | string | undefined;
      const message = typeof reason === 'string' ? reason : (reason?.message ?? '');
      if (isChunkLoadFailure(message)) recover();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
