'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Pencil } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Inline editors for the ticket's own properties (operator, 2026-08-10).
 *
 * *«все поля слева должны быть плейсхолдерами, то есть их можно было поменять… можно сделать
 * placeholder без явных рамочек. Это будет симпатично.»*
 *
 * ── The shape, and why it is this one ────────────────────────────────────────────────────────────
 * A field reads as TEXT until you touch it. No box, no border — the editor appears only once you have
 * said you want it. That is the "placeholder without frames" he asked for.
 *
 * ⚠️ **A value that is merely unset must still be reachable.** The tempting version renders an empty
 * string for a missing value, which gives a person nothing to click and makes an editable field
 * indistinguishable from a read-only one. So an unset value renders its `placeholder` in muted text
 * — a target, and a statement that the field is empty rather than broken.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐⭐ **2026-08-10, second pass — "hover is the whole invitation" was WRONG, and the operator's own
 * report is the evidence.** Reading the finished screen: *«я всё ещё не вижу возможности менять поля
 * типа бренд, ассайни»* — while Brand had been an `EditableChoice` since that morning and Assignee was
 * genuinely read-only. He could not tell the two apart, because **at rest they rendered identically**:
 * `EditableChoice` and `ReadOnlyValue` were both bare text in the same slot, and the only difference
 * lived in a hover state you have to already suspect is there to go looking for it.
 *
 * ⇒ An editable field now carries a QUIET, PERMANENT mark: a chevron on a chooser, a pencil on a text
 * field, muted at rest and full-strength on hover/focus. `ReadOnlyValue` carries none — so the
 * distinction is visible without touching anything, which is the property that was missing.
 *
 * ⓘ This is not the "explicit frame" he rejected (*«без явных рамочек»*): no box, no border, no filled
 * control — the words still read as words. It is the smallest possible statement that a field answers
 * to a click, and it is what every chooser in ui.shadcn.com does for exactly this reason (rule 11).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **Nothing here is optimistic.** Both editors report the value they were GIVEN, and the caller
 * re-reads after the write (`ticket.sagas`). A local echo would show a change the server refused —
 * exactly the confidently-wrong-answer shape this codebase keeps finding — and a title comes back
 * normalised (whitespace collapsed), so an echo would be wrong even on success.
 */

/** Shared skin: text that becomes a control on hover, never a box that sits there being one. */
const SLOT =
  'w-full truncate rounded-sm px-1 -mx-1 py-0.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The at-rest layout of an editable field: the value takes the room, the mark sits at the end.
 * `group` is what lets the mark brighten with the whole row rather than only under the cursor.
 */
const SLOT_ROW = `${SLOT} group flex items-center gap-1`;

/**
 * The mark itself. Visible at rest (`opacity-60`) — that is the entire point, see the note above — and
 * full strength once the field is hovered or focused. `shrink-0` so it survives a truncated value:
 * losing the affordance is exactly the failure this is fixing.
 */
const MARK = 'h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100';

/**
 * A one-line text value edited in place. Enter commits, Escape abandons, blur commits — because a
 * click elsewhere after typing means "yes", and losing the edit there would be the surprising answer.
 *
 * ⓘ An unchanged value does NOT call `onCommit`: a no-op PATCH is a write in the audit trail and a
 * re-read on the screen, both saying that nothing happened.
 */
export function EditableText({
  value,
  placeholder,
  onCommit,
  disabled = false,
  ariaLabel,
  testId,
  className,
  inputClassName,
}: {
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId: string;
  className?: string;
  inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft follows the record while the field is at rest. Without this a re-read (someone else
  // renamed it, or the server normalised what we sent) would be overwritten by a stale draft the
  // moment the person clicked in again.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === '' || next === value.trim()) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };

  if (!editing) {
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        className={cn(SLOT_ROW, value === '' && 'text-muted-foreground', className)}
        title={value || placeholder}
      >
        <span className="min-w-0 flex-1 truncate">{value || placeholder}</span>
        <Pencil className={MARK} aria-hidden />
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      data-testid={`${testId}-input`}
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      // Borderless in the same slot the text occupied, so committing does not shift the layout.
      className={cn(SLOT, 'bg-muted focus-visible:ring-0', className, inputClassName)}
    />
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/**
 * A value chosen from a closed list. Renders as text, opens a menu on click.
 *
 * ⚠️ The options are always the SERVER's list (the account's statuses, the account's brands, the
 * product's priorities) — never a literal in a screen. A screen that spelled its own vocabulary is
 * how the Inbox rail once offered a retired status key and every agent who clicked got a 400.
 */
export function EditableChoice({
  value,
  options,
  placeholder,
  onCommit,
  disabled = false,
  ariaLabel,
  testId,
  allowClear = false,
  clearLabel = 'Clear',
}: {
  value: string;
  options: readonly ChoiceOption[];
  placeholder: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId: string;
  /** Offer "no value" as a choice — only where the empty value is a real state of the field. */
  allowClear?: boolean;
  clearLabel?: string;
}) {
  const current = options.find((o) => o.value === value);
  // An unknown value still RENDERS — a retired status on an old ticket is a fact, and hiding it
  // would make the field look empty. It just cannot be chosen again, because it is not in the list.
  const shown = current?.label ?? value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          disabled={disabled || options.length === 0}
          aria-label={ariaLabel}
          className={cn(SLOT_ROW, shown === '' && 'text-muted-foreground')}
          title={shown || placeholder}
        >
          <span className="min-w-0 flex-1 truncate">{shown || placeholder}</span>
          {/* ⓘ Dropped when there is nothing to choose (the button is `disabled` then too) — a chevron
              on a control that cannot open is the same lie in the other direction. */}
          {options.length > 0 && <ChevronDown className={MARK} aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {allowClear && (
          <DropdownMenuItem
            data-testid={`${testId}-clear`}
            onSelect={() => value !== '' && onCommit('')}
          >
            <span className="text-muted-foreground">{clearLabel}</span>
          </DropdownMenuItem>
        )}
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-testid={`${testId}-option-${o.value}`}
            // Choosing what is already set is a no-op write and a re-read that says nothing changed.
            onSelect={() => o.value !== value && onCommit(o.value)}
          >
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A field that cannot be changed here, rendered so it does not pretend to be one that can.
 *
 * ⚠️ **It carries NO mark, and that absence is now load-bearing** (2026-08-10): the chevron and the
 * pencil above are what say "this answers to a click", so their absence is what says the opposite.
 * Adding either here would re-create the confusion the operator reported — and adding a hover
 * background would too, since that was the old, unreadable signal.
 */
export function ReadOnlyValue({
  value,
  mono = false,
  hint,
}: {
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={cn('truncate px-1 -mx-1 py-0.5 text-sm', mono && 'font-mono')}
      title={hint ?? value ?? undefined}
    >
      {value || '—'}
    </div>
  );
}
