'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useDataAccess } from '@/data/provider';
import { setUnreadSoundEnabled } from '@/lib/unread-chime';
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
        <UnreadSoundToggle />
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
 * ⭐ W25 (R23) — the arrival sound's PERSONAL switch («настраиваемый актив с личным выключателем»).
 *
 * Writes through to `unread_sound` in the ui-preferences catalogue (the theme's own path, W18) AND
 * updates the chime module's cache, so flipping it silences THIS tab now — not after a reload. The
 * optimistic order is the theme's too: the switch obeys the click immediately, a failed save is
 * reported in words, and the server remains the cross-machine truth.
 */
function UnreadSoundToggle() {
  const dataAccess = useDataAccess();
  // ⚠️ `null` until the server answers — NOT an assumed default: the catalogue owns the default
  // (FR-006, and its guard scans for exactly this), and the read always returns every key.
  const [on, setOn] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .get<{ values?: Record<string, string> }>('ui-preferences', '')
      .then((res) => {
        if (!alive) return;
        const v = res?.values?.unread_sound;
        const isOn = v === 'on';
        setOn(isOn);
        setUnreadSoundEnabled(isOn);
      })
      .catch(() => {
        // The switch simply does not render — better absent than showing a state that may be a lie.
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  const toggle = (next: boolean) => {
    setOn(next);
    setUnreadSoundEnabled(next);
    setSaveError(null);
    const value = next ? 'on' : 'off';
    void dataAccess
      .update('ui-preferences', '', { values: { unread_sound: value } })
      .catch((e: unknown) => {
        setSaveError(e instanceof Error ? e.message : 'could not be saved');
      });
  };

  if (on === null) return null;
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-sm">New-ticket sound</span>
      <Switch
        data-testid="unread-sound-toggle"
        checked={on}
        onCheckedChange={toggle}
        aria-label="Play a quiet sound when a new ticket arrives"
      />
      <span className="text-xs text-muted-foreground">
        Quiet chime on arrivals while you are elsewhere — yours only, nobody else’s.
      </span>
      {saveError && (
        <span className="text-sm text-destructive" data-testid="sound-save-error">
          Changed here, but could not be saved: {saveError}
        </span>
      )}
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
      {/* ⭐ W36 / feature 041 (roadmap 3.18) — the reserved slot, filled. */}
      <ChangePassword />
    </section>
  );
}

/**
 * ⭐ W36 / feature 041 (roadmap 3.18) — change your own password.
 *
 * ── Two things this form says before it does anything ────────────────────────────────────────────
 * That it will sign you out everywhere, and that you will need the current password. Both belong on the
 * screen rather than in a surprise afterwards: a person who discovers mid-flow that they have been signed
 * out of three other tabs experiences a bug, not a security feature.
 *
 * ⚠️ **On success the person is SENT TO SIGN IN**, because their own session is among the revoked ones.
 * Leaving them on a settings page whose every renewal is already dead is the worse of the two options —
 * it looks like it worked and then fails at the next click.
 *
 * ⚠️ A wrong current password is `rejected`, the same word sign-in uses, and it counts toward the same
 * lockout. This form is a password oracle if it answers faster or differently than the login page does.
 */
function ChangePassword() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'rejected' | 'weak' | 'failed'>('idle');
  const [failures, setFailures] = useState<string[]>([]);

  const RULES: Readonly<Record<string, string>> = {
    min_length: 'at least 8 characters',
    uppercase: 'an upper-case letter',
    digit: 'a digit',
    symbol: 'a symbol',
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !next || state === 'saving') return;
    setState('saving');
    setFailures([]);
    const outcome = await session.changePassword(current, next);
    if (outcome.kind === 'ok') {
      // The receipt is the sign-in page: the session that asked for this change no longer exists.
      await refresh();
      router.push('/login');
      return;
    }
    if (outcome.kind === 'rejected') return setState('rejected');
    if (outcome.kind === 'weak_password') {
      setFailures(outcome.failures);
      return setState('weak');
    }
    setState('failed');
  };

  return (
    <form className="space-y-2 border-t border-border pt-3" onSubmit={submit} data-testid="change-password">
      <h3 className="text-sm font-medium">Change password</h3>
      <p className="text-xs text-muted-foreground">
        You will be signed out everywhere and asked to sign in again.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          aria-label="Current password"
          data-testid="change-password-current"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          disabled={state === 'saving'}
          className="h-8 text-sm"
        />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="New password"
          aria-label="New password"
          data-testid="change-password-new"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={state === 'saving'}
          className="h-8 text-sm"
        />
      </div>
      {state === 'rejected' && (
        <p role="alert" className="text-xs text-destructive" data-testid="change-password-rejected">
          That is not your current password.
        </p>
      )}
      {state === 'weak' && (
        <p role="alert" className="text-xs text-destructive" data-testid="change-password-weak">
          Add {failures.map((f) => RULES[f] ?? f).join(', ')}.
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="text-xs text-destructive" data-testid="change-password-failed">
          The password could not be changed. Try again.
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        data-testid="change-password-submit"
        disabled={state === 'saving' || !current || !next}
      >
        {state === 'saving' ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  );
}
