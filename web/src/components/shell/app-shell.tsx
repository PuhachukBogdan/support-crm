'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandMenu } from './command-menu';
import { NavHistoryProvider } from './back';
import { useContextPanel } from './context-panel';

/**
 * The application shell (S3). Built ONCE; feature screens plug into the content slot and
 * (optionally) the right context-panel slot — they never modify the shell itself.
 *
 * ⭐ W22 (R41): the `collapsed` state is GONE, not defaulted. The rail has one width and no toggle —
 * the names live in hover labels instead. Keeping the state "just in case" would have left a dead
 * prop threaded through two components and a test asserting a control nobody can reach.
 *
 * ⭐ W22 (R44): `NavHistoryProvider` wraps the whole shell, because "back" must work from any screen
 * and must know where the person actually came from — which no individual page can know.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const { node } = useContextPanel();

  return (
    <NavHistoryProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenCommand={() => setCommandOpen(true)} />

          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1 overflow-auto p-6">{children}</main>

            {node && (
              <aside
                data-testid="context-panel"
                className="w-80 shrink-0 overflow-auto border-l border-border bg-card p-4"
              >
                {node}
              </aside>
            )}
          </div>
        </div>

        <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
      </div>
    </NavHistoryProvider>
  );
}
