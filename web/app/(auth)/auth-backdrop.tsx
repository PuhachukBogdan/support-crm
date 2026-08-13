'use client';

import type { ComponentType } from 'react';
import FerrofluidImpl from '@/components/Ferrofluid';

// React Bits Ferrofluid is untyped JS; loosen its props (all optional) for our TS pages.
const Ferrofluid = FerrofluidImpl as unknown as ComponentType<Record<string, unknown>>;

/**
 * ⭐ W36 / feature 041 — the backdrop the unauthenticated screens share.
 *
 * ── Why this exists and why `login` does NOT use it ──────────────────────────────────────────────
 * The recovery screens live in the same flow as sign-in and must not look like a different product, so
 * they render the same fluid background and the same soft radial blur.
 *
 * ⚠️ **`login/page.tsx` keeps its own copy, deliberately.** Its visual layer is FROZEN by operator
 * instruction and pinned value-by-value in `login/frozen-visual.test.tsx`, a test scoped to that file —
 * so extracting it would break the guard that protects it, and the operator explicitly took `login` and
 * `register` out of W40's retrofit (*«вход и регистрация уже хороши»*). Converging the two is a decision
 * about those screens, not a side effect of adding a third.
 *
 * ⇒ The duplication is named rather than hidden: if the frozen values ever change, this file is the
 * second place, and `auth-backdrop.matches-login.spec.tsx` fails so the divergence is loud.
 */
export function AuthBackdrop() {
  return (
    <>
      {/* Decorative WebGL background. Dark backdrop (token-driven) so the white fluid shows. */}
      <div aria-hidden className="dark fixed inset-0 z-0 bg-background">
        <Ferrofluid
          colors={['#ffffff', '#ffffff', '#ffffff']}
          speed={0.5}
          scale={1.6}
          turbulence={1}
          fluidity={0.1}
          rimWidth={0.2}
          sharpness={2.5}
          shimmer={1.5}
          glow={2}
          flowDirection="down"
          opacity={1}
          mouseInteraction
          mouseStrength={1}
          mouseRadius={0.35}
        />
      </div>

      {/* The soft radial blur that puts the focus on the card. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-1/2 top-1/2 z-[1] h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full backdrop-blur-[8px]"
        style={{
          WebkitMaskImage: 'radial-gradient(closest-side, black 55%, transparent 100%)',
          maskImage: 'radial-gradient(closest-side, black 55%, transparent 100%)',
        }}
      />
    </>
  );
}
