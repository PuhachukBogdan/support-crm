import { cn } from '@/lib/utils';

export type StatusKind = 'status' | 'priority';

/**
 * Value → token-driven tone. NO inline/ad-hoc colours — only semantic token classes (FR-010).
 *
 * ── ⭐ Re-toned 2026-08-03 on the operator's instruction, from the real Zendesk ─────────────────
 * The previous map used a different bright hue for every status — blue · orange · green · grey — so
 * a column of them read as a rainbow. His words: *«какие-то у нас слишком цветастые, яркие»*.
 *
 * Zendesk carries colour only where it means something, and leaves the rest neutral:
 *
 *   **Open → red · Pending → blue · Solved/Resolved → grey · everything else → near-black**
 *
 * So exactly two statuses are saturated, and they are the two an agent scans for. Everything else,
 * including any custom status (§17 — statuses are data, and there will be many: *VIP Pending*,
 * *In progress*, *Follow-up*, *Auto-Ended Chat*, *Supervisor Review*), stays neutral rather than
 * being handed a colour nobody chose.
 *
 * ⚠️ **"Black" is `foreground`, not black.** A literal black chip is invisible in the dark theme,
 * which Zendesk's screenshots cannot show us because they only exist in light. `--foreground` is
 * near-black in light and near-white in dark, so the intent survives the theme switch — and it stays
 * a token, which white-label requires (rule 6 / ADR 0028).
 */
const STATUS_TONES: Record<string, string> = {
  /**
   * ⭐ R38 (2026-08-05): **Open moved to the neutral `foreground` token, and red is FREED to mean
   * exactly one thing — a new message from the customer** (the 9.12 unread marker, when it lands).
   * Until 9.12 ships, nothing on this screen is red, deliberately: a colour that means one thing
   * must not spend the interim meaning another.
   */
  open: 'bg-foreground text-background',
  pending: 'bg-info text-info-foreground',
  // Our wire calls it `resolved`; Zendesk calls it `Solved`. Same state, both spellings mapped so a
  // rename on either side does not silently fall through to the neutral tone.
  resolved: 'bg-muted text-muted-foreground',
  solved: 'bg-muted text-muted-foreground',
  closed: 'bg-muted text-muted-foreground',
};

const PRIORITY_TONES: Record<string, string> = {
  low: 'bg-muted text-muted-foreground',
  normal: 'bg-info text-info-foreground',
  high: 'bg-warning text-warning-foreground',
  urgent: 'bg-destructive text-destructive-foreground',
};

/**
 * Any status we were not told about — including every custom status the admin will invent.
 * ⚠️ Deliberately the neutral near-black rather than `muted`: an unknown status must be **readable
 * and unremarkable**, not quietly dressed as "solved".
 */
const FALLBACK_STATUS = 'bg-foreground text-background';

/** A priority we were not told about. Muted, because an unknown priority is not an urgent one. */
const FALLBACK_PRIORITY = 'bg-muted text-muted-foreground';

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
  const tone = map[value] ?? (kind === 'status' ? FALLBACK_STATUS : FALLBACK_PRIORITY);
  return (
    <span
      data-kind={kind}
      className={cn(
        // ⭐ `rounded` — a rectangle with soft corners, not `rounded-full`. The operator, comparing
        // ours to Zendesk: «они идут не овалами, а такими типа, как прямоугольниками с закругленными
        // углами. Мне кажется, это выглядит чуть-чуть получше.»
        'inline-flex items-center rounded px-2 py-0.5 text-xs font-medium capitalize',
        tone,
        className,
      )}
    >
      {value}
    </span>
  );
}
