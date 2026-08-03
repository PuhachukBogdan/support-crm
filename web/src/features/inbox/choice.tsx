'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * A labelled dropdown for the Inbox toolbar.
 *
 * ── ⭐ Why this exists instead of a raw `<select>` ───────────────────────────────────────────────
 * The filters and the sort control were hand-rolled native `<select>` elements. Two problems, and the
 * second is severe:
 *
 * 1. **It bypassed our own primitive.** `components/ui/select.tsx` has existed since S1; a screen
 *    hand-rolling a control is exactly what the layer exists to prevent, and it is why these looked
 *    like browser defaults rather than like the product.
 * 2. ⚠️ **A native `<select>` opens an OPERATING-SYSTEM popup**, and choosing from it froze the
 *    renderer at 100% CPU — reproduced live: the identical change made programmatically never froze,
 *    the same change through the real popup froze every time. It was traced to a large synchronous
 *    DOM teardown landing while that popup closed, and fixed there; the operator then hit it again on
 *    a filter that returns nothing. ⇒ **Remove the OS popup entirely.** Radix renders its list in the
 *    page, so there is no native widget to be mid-close during a commit.
 *
 * ⓘ It also matches the screenshots: Zendesk's `Status ▽` / `Channel ▽` are styled buttons, not
 * browser selects (`ui-design/screenshots/home.png`).
 */
export function Choice({
  label,
  value,
  onChange,
  options,
  anyLabel = 'Any',
  testId,
}: {
  label: string;
  /** `undefined` = no choice made; rendered as `anyLabel`. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: readonly string[];
  anyLabel?: string;
  testId: string;
}) {
  /**
   * ⚠️ Radix cannot carry an empty-string item value, so "no choice" needs a sentinel. It is mapped
   * back to `undefined` immediately — the query layer must never see the sentinel, because an
   * undeclared filter value is refused before a request exists.
   */
  const ANY = '__any__';

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={value ?? ANY}
        onValueChange={(next) => onChange(next === ANY ? undefined : next)}
      >
        <SelectTrigger data-testid={testId} className="h-9 w-[9.5rem]" aria-label={label}>
          <SelectValue placeholder={anyLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
