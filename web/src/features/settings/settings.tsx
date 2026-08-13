'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useThemeMode } from './use-theme-mode';

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

      <section className="space-y-1 rounded-md border border-border p-3" data-testid="settings-profile">
        <h2 className="text-sm font-semibold">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Your avatar and presence status arrive with block W19 (points 8.10, 5.9) — reserved, not
          missing. Your name is not editable by decision: it is how colleagues and the audit trail
          know you.
        </p>
      </section>
    </div>
  );
}
