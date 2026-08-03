'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Error boundary for every dashboard screen (feature 029 follow-up).
 *
 * ⚠️ **This is the boundary whose absence produced "the site hangs".** With no `error.tsx`, a render
 * error anywhere under the shell unmounted the entire tree: the operator got a blank page that did
 * not answer clicks or scrolling, DevTools showed an empty `<body>`, and the console showed nothing
 * useful. There was no way to tell a crash from a freeze — and the two need opposite fixes.
 *
 * ⇒ Now the shell survives, the failure is named on screen, and recovery is one button. `reset()`
 * re-renders the segment; if the cause was transient that is enough, and if it is not, the message
 * stays readable instead of vanishing.
 *
 * ⛔ It shows the error text on purpose. This is an internal tool for ~58 colleagues, not a public
 * site, and a message a person can read to us is worth more than a tidy apology. It carries no
 * customer data: React's client errors are the component's own, and anything server-side arrives as
 * an opaque `digest` precisely so response contents cannot leak here.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Also to the console, so a screenshot of DevTools carries the same string as the screen.
    console.error('[dashboard] render failed:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-12" data-testid="dashboard-error">
      <h1 className="text-xl font-semibold">This screen failed to render</h1>
      <p className="text-muted-foreground">
        The rest of the application still works — use the navigation to move elsewhere. The details
        below are what to send on.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-4 text-xs">
        {error.name}: {error.message}
        {error.digest ? `\ndigest: ${error.digest}` : ''}
      </pre>
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.assign('/')}>
          Back to the Inbox
        </Button>
      </div>
    </div>
  );
}
