'use client';

import { Inbox, Clock, CheckCircle2, AlertTriangle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/composites/status-badge/status-badge';
import { StatCard } from '@/components/composites/stat-card/stat-card';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/composites/states';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRecords } from '@/store/async/hooks';
import type { DemoRecord } from '@/data/mock/demo-data';

// Dashboard (D2): KPI tiles + the ticket list as expressive block rows (tight spacing gives
// weight), token-styled. Data via useRecords (the C interface); real gateway swaps in later.
function TicketBlocks({ items }: { items: DemoRecord[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => toast(t.subject)}
            className={cn(
              'flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t.subject}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                #{t.id} · updated {new Date(t.updatedAt).toLocaleDateString()}
              </p>
            </div>
            {/* Badges size to their text; fixed-width slots (right-aligned) keep the priority
                and status columns lined up across rows so they don't float randomly. */}
            <div className="flex shrink-0 items-center gap-2">
              <span className="flex w-20 justify-end">
                <StatusBadge kind="priority" value={t.priority} />
              </span>
              <span className="flex w-24 justify-end">
                <StatusBadge kind="status" value={t.status} />
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function DashboardHome() {
  const state = useRecords({ limit: 25 });
  const items = state.status === 'ready' ? state.data.items : [];
  const by = (s: DemoRecord['status']) => items.filter((r) => r.status === s).length;
  const urgent = items.filter((r) => r.priority === 'urgent').length;

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-500">
      <PageHeader
        title="Tickets"
        actions={
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            New ticket
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Open" value={by('open')} icon={<Inbox className="h-4 w-4" />} />
        <StatCard label="Pending" value={by('pending')} icon={<Clock className="h-4 w-4" />} />
        <StatCard
          label="Resolved"
          value={by('resolved')}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatCard
          label="Urgent"
          value={urgent}
          hint="by priority"
          icon={<AlertTriangle className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All tickets</CardTitle>
          <CardDescription>Mock data — click a ticket. Swapped for the gateway as backend lands.</CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === 'loading' || state.status === 'idle' ? (
            <div data-testid="tickets-loading">
              <LoadingRows />
            </div>
          ) : state.status === 'error' ? (
            <ErrorState error={state.error} onRetry={state.refetch} />
          ) : state.status === 'empty' ? (
            <div data-testid="tickets-empty">
              <EmptyState title="No tickets yet" description="They'll appear here." />
            </div>
          ) : (
            <TicketBlocks items={items} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
