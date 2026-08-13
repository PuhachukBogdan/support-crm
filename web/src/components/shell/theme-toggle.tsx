'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useThemeMode } from '@/features/settings/use-theme-mode';

/**
 * Light/dark switch. W18: rides the SAME hook as the settings page, so a topbar flip persists to
 * the account exactly like the settings control — two switches, one behaviour. A failed save keeps
 * the local flip and stays quiet HERE (the settings page is where the error has a place to be
 * said); the theme still holds through a reload via next-themes' own store.
 */
export function ThemeToggle() {
  const { resolvedTheme, setMode } = useThemeMode();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => void setMode(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
