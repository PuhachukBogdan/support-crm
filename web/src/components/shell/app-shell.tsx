'use client';

import { useState, type ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandMenu } from './command-menu';
import { useContextPanel } from './context-panel';

// The application shell (S3). Built ONCE; feature screens plug into the content slot and
// (optionally) the right context-panel slot — they never modify the shell itself.
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { node } = useContextPanel();

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar collapsed={collapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onToggleSidebar={() => setCollapsed((c) => !c)}
          onOpenCommand={() => setCommandOpen(true)}
        />

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
  );
}
