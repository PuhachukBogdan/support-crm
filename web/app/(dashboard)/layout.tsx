import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { ContextPanelProvider } from '@/components/shell/context-panel';
import { Toaster } from '@/components/ui/sonner';

// Dashboard route group: wraps every dashboard page in the shell + context-panel slot +
// toast host. The command-palette host lives inside AppShell.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <ContextPanelProvider>
      <AppShell>{children}</AppShell>
      <Toaster />
    </ContextPanelProvider>
  );
}
