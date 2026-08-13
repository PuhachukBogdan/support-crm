'use client';

import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState } from '@/data/types';

interface Bucket {
  key?: string;
  count?: number;
}
interface SnapshotWire {
  createdToday?: number;
  openNow?: number;
  avgFirstReplySeconds?: number;
  firstReplyCount?: number;
  byChannel?: Bucket[];
  byAgent?: Bucket[];
  pendingByAgent?: Bucket[];
  volumeByDay?: Bucket[];
}
interface OperatorWire {
  operatorId?: string;
  displayName?: string;
}

/**
 * W20 — Analytics, the minimum that is TRUE (subpoints 6.2 + 6.3 + 6.4; roadmap 11.1 minimum).
 *
 * Four live numbers, three breakdowns and ONE chart — every value read straight from the journal
 * at request time (the operator's decision: the rollup store is post-MVP; synthetic data answers
 * instantly). "In work" is the account's non-terminal CATEGORIES; ⭐ `pending` per agent is 6.4's
 * parking-lot number — Pending removes a ticket from every active list and is set by the agent
 * themselves, so this count is what makes the parking visible.
 *
 * The chart: one series (created per day), so no legend — the title names it (the dataviz rule);
 * bars in the product's own token, labels in text tokens, per-bar hover via the native title.
 * Agent axes resolve ids to NAMES through the read the inbox already owns, degrading to the id.
 */
export function Analytics() {
  const dataAccess = useDataAccess();
  const [snap, setSnap] = useState<AsyncState<SnapshotWire>>({ status: 'idle' });
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    setSnap({ status: 'loading' });
    void dataAccess
      .get<SnapshotWire>('analytics-snapshot', '', undefined, { days: 14 })
      .then(async (res) => {
        if (!alive) return;
        setSnap({ status: 'ready', data: res });
        // Resolve the few distinct assignee ids to names; '' (unassigned) stays a labelled absence.
        const ids = [...new Set([...(res.byAgent ?? []), ...(res.pendingByAgent ?? [])].map((b) => b.key ?? '').filter(Boolean))];
        const map = new Map<string, string>();
        await Promise.all(
          ids.slice(0, 30).map(async (id) => {
            try {
              const op = await dataAccess.get<OperatorWire>('operators', id);
              if (op?.displayName) map.set(id, op.displayName);
            } catch {
              // The id stays — worse-looking, still true.
            }
          }),
        );
        if (alive) setNames(map);
      })
      .catch((e) => alive && setSnap({ status: 'error', error: toDataError(e) }));
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  if (snap.status === 'error') {
    return (
      <div className="mx-auto w-full max-w-4xl py-8">
        <p className="text-sm text-destructive" data-testid="analytics-error">
          {snap.error.message}
        </p>
      </div>
    );
  }
  if (snap.status !== 'ready') {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 py-8">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const s = snap.data;
  const nameOf = (id: string) => (id ? (names.get(id) ?? shortId(id)) : 'не назначено');
  const avg = s.avgFirstReplySeconds ?? -1;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="Analytics" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="stat-tiles">
        <Tile label="Создано сегодня" value={String(s.createdToday ?? 0)} testid="stat-created-today" />
        <Tile label="В работе сейчас" value={String(s.openNow ?? 0)} testid="stat-open-now" />
        <Tile
          label="Средний первый ответ"
          value={avg < 0 ? '—' : formatSeconds(avg)}
          hint={avg < 0 ? 'ещё не измерялся' : `по ${s.firstReplyCount ?? 0} ответам`}
          testid="stat-first-reply"
        />
        <Tile
          label="В Pending всего"
          value={String((s.pendingByAgent ?? []).reduce((a, b) => a + (b.count ?? 0), 0))}
          hint="парковка, по агентам ниже"
          testid="stat-pending"
        />
      </div>

      <VolumeChart days={s.volumeByDay ?? []} />

      <div className="grid gap-4 sm:grid-cols-3">
        <BreakdownList
          title="В работе — по каналам"
          rows={(s.byChannel ?? []).map((b) => ({ label: b.key || 'без канала', count: b.count ?? 0 }))}
          testid="by-channel"
        />
        <BreakdownList
          title="В работе — по агентам"
          rows={(s.byAgent ?? []).map((b) => ({ label: nameOf(b.key ?? ''), count: b.count ?? 0 }))}
          testid="by-agent"
        />
        <BreakdownList
          title="⭐ Pending — по агентам (6.4)"
          rows={(s.pendingByAgent ?? []).map((b) => ({ label: nameOf(b.key ?? ''), count: b.count ?? 0 }))}
          empty="никто ничего не паркует"
          testid="pending-by-agent"
        />
      </div>
    </div>
  );
}

function Tile({ label, value, hint, testid }: { label: string; value: string; hint?: string; testid: string }) {
  return (
    <div className="rounded-md border border-border p-3" data-testid={testid}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** One series ⇒ no legend — the title names it (the dataviz rule). Шаг 1: the hand-made `div`
 *  bars became the library's `Chart` (Recharts under shadcn's wrapper) — animated, with a real
 *  tooltip. The series wears `--chart-1` through ChartConfig (tokens only; the palette's
 *  multi-series hazards are recorded on W38, the first block that would meet them).
 *  ⓘ `minPointSize={2}` keeps the old promise: a zero day is a visible stub, never a hole.
 *  ⚠️ jsdom gives ResponsiveContainer no size, so the BARS are asserted in the live browser
 *  check; the jsdom test asserts the frame and the data reaching it. */
const volumeConfig = {
  count: { label: 'Создано', color: 'hsl(var(--chart-1))' },
} satisfies ChartConfig;

function VolumeChart({ days }: { days: Bucket[] }) {
  const data = days.map((d) => ({ key: d.key ?? '', count: d.count ?? 0 }));
  return (
    <section
      className="space-y-1 rounded-md border border-border p-3"
      data-testid="volume-chart"
      data-days={data.length}
    >
      <h2 className="text-sm font-medium">Обращения по дням (создано)</h2>
      <ChartContainer config={volumeConfig} className="h-36 w-full">
        <BarChart accessibilityLayer data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={24}
            interval="preserveStartEnd"
            tickFormatter={(v: string) => v.slice(5)}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} minPointSize={2} />
        </BarChart>
      </ChartContainer>
    </section>
  );
}

function BreakdownList({
  title,
  rows,
  empty,
  testid,
}: {
  title: string;
  rows: Array<{ label: string; count: number }>;
  empty?: string;
  testid: string;
}) {
  return (
    <section className="space-y-1 rounded-md border border-border p-3" data-testid={testid}>
      <h2 className="text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty ?? 'пусто'}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.label} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="tabular-nums text-muted-foreground">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  return `${(s / 3600).toFixed(1)} ч`;
}
