'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useSession } from '@/session';
import { useThemeMode } from './use-theme-mode';
import { ProfileSection } from './profile-section';

/**
 * W18 — the PERSONAL settings shell (subpoint 5.2 → roadmap 8.7, ADR 0035).
 *
 * ── Deliberately an OUTLINE, not a framework ─────────────────────────────────────────────────────
 * 8.7's own words: the shell exists early so future settings do not scatter across topbars and
 * context menus — and deliberately NO settings framework (no schema registry, no form generation).
 * Three categories (UI / Accessibility / Profile), one REAL control today (the theme, 5.3), and the
 * other two are labelled reserved slots each carrying the point that fills it — the admin-sections
 * convention, reused.
 *
 * ⚠️ These are the operator's OWN settings (ADR 0035): not the admin centre (`/admin` owns tenant
 * configuration), not Access Management. Nothing here needs a permission beyond being signed in —
 * which is why the rail entry lost its admin key in this same block.
 */
export function Settings() {
  const { resolvedTheme, setMode, error } = useThemeMode();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="Settings" />

      <section className="space-y-2 rounded-md border border-border p-3" data-testid="settings-ui">
        <h2 className="text-sm font-semibold">Interface</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm">Theme</span>
          <Button
            size="sm"
            variant={!isDark ? 'secondary' : 'outline'}
            data-testid="theme-light"
            onClick={() => void setMode('light')}
          >
            Light
          </Button>
          <Button
            size="sm"
            variant={isDark ? 'secondary' : 'outline'}
            data-testid="theme-dark"
            onClick={() => void setMode('dark')}
          >
            Dark
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved to your account — it follows you to any machine, and holds through a reload.
        </p>
        {error && (
          <p className="text-sm text-destructive" data-testid="theme-save-error">
            The theme changed here but could not be saved: {error.message}
          </p>
        )}
      </section>

      {/* Reserved, each with its owner — a slot with no point is how a screen stays reserved forever. */}
      <section className="space-y-1 rounded-md border border-border p-3" data-testid="settings-accessibility">
        <h2 className="text-sm font-semibold">Accessibility</h2>
        <p className="text-sm text-muted-foreground">
          Font size steps arrive with point 8.9 — reserved, not missing.
        </p>
      </section>

      {/* ⭐ W19: the Profile slot stopped being a promise — avatar (5.4) + presence (5.5). */}
      <ProfileSection />

      {/* ⭐ W22: the Account slot, and the only reason it exists yet is where sign-out went (R40). */}
      <AccountSection />
    </div>
  );
}

/**
 * W22 — account actions (R40).
 *
 * Sign-out lives here now, on the operator's instruction: *«я думаю, logout сделать именно в
 * настройках аккаунта, потому что в той всплывающей панели, где можно выставить себе статус и так
 * далее, это как-то слишком легко. Разлогиниться можно, но в этом особого смысла нет, потому что
 * никто logout часто делать не будет»*.
 *
 * ⚠️⚠️ **The guarantee moved with the button, and that is the point of this note.** Signing out ends
 * the session **on the server** and then re-asks the gateway rather than assuming the answer — the
 * browser does not decide when a session is over. The original handler flipped a local flag, which
 * is not a sign-out at all: the cookie would have kept working everywhere it had been sent. That
 * property was asserted in `shell.test.tsx` while the control lived in the top bar; the assertion
 * moved to `settings.test.tsx` in the same commit. A check that stays behind when its subject moves
 * is how a guarantee evaporates while every file still looks correct.
 */
function AccountSection() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await session.signOut();
      await refresh();
      router.push('/login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="settings-account">
      <h2 className="text-sm font-semibold">Account</h2>
      <p className="text-xs text-muted-foreground">
        Signing out ends this session on the server, on every device it was used from.
      </p>
      <Button size="sm" variant="outline" disabled={busy} data-testid="sign-out" onClick={() => void signOut()}>
        Sign out
      </Button>
      {/* ⏳ Password change lands here with W36 — the surface does not exist anywhere yet. */}
      <p className="text-xs text-muted-foreground">
        Changing your password arrives with point 3.18 — reserved, not missing.
      </p>
    </section>
  );
}
