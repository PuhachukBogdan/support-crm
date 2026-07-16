'use client';

import { useState } from 'react';
import { SampleButton } from '../src/components/sample-button';
import { Button } from '../src/components/ui/button';

// Phase-0 sample page: renders the themed sample and a light/dark toggle that flips the
// token set purely by toggling the `.dark` class on <html> (no color code changes).
export default function Home() {
  const [dark, setDark] = useState(false);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    document.documentElement.classList.toggle('light', !next);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
      <h1 className="text-2xl font-semibold">Phase 0 scaffold</h1>
      <SampleButton />
      <Button onClick={toggleTheme}>Switch to {dark ? 'light' : 'dark'} theme</Button>
    </main>
  );
}
