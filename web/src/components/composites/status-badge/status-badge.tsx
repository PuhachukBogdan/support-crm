import { cn } from '@/lib/utils';

export type StatusKind = 'status' | 'priority';

// Value → token-driven tone. NO inline/ad-hoc colors — only semantic token classes (FR-010).
const STATUS_TONES: Record<string, string> = {
  open: 'bg-info text-info-foreground',
  pending: 'bg-warning text-warning-foreground',
  resolved: 'bg-success text-success-foreground',
  closed: 'bg-muted text-muted-foreground',
};

const PRIORITY_TONES: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  normal: 'bg-info text-info-foreground',
  high: 'bg-warning text-warning-foreground',
  urgent: 'bg-destructive text-destructive-foreground',
};

const FALLBACK = 'bg-muted text-muted-foreground';

/** Status/priority indicator. Variant comes from tokens, never a hardcoded color. */
export function StatusBadge({
  kind,
  value,
  className,
}: {
  kind: StatusKind;
  value: string;
  className?: string;
}) {
  const map = kind === 'status' ? STATUS_TONES : PRIORITY_TONES;
  const tone = map[value] ?? FALLBACK;
  return (
    <span
      data-kind={kind}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        tone,
        className,
      )}
    >
      {value}
    </span>
  );
}
