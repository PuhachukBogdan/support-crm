'use client';

import { useEffect, useRef, useState } from 'react';
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
 * A field reads as TEXT until you touch it. No box, no border, no control affordance sitting there
 * competing with the words — the hover state is the whole invitation, and the editor appears only
 * once you have said you want it. That is the "placeholder without frames" he asked for.
 *
 * ⚠️ **A value that is merely unset must still be reachable.** The tempting version renders an empty
 * string for a missing value, which gives a person nothing to click and makes an editable field
 * indistinguishable from a read-only one. So an unset value renders its `placeholder` in muted text
 * — a target, and a statement that the field is empty rather than broken.
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
        className={cn(SLOT, value === '' && 'text-muted-foreground', className)}
        title={value || placeholder}
      >
        {value || placeholder}
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
          className={cn(SLOT, shown === '' && 'text-muted-foreground')}
          title={shown || placeholder}
        >
          {shown || placeholder}
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

/** A field that cannot be changed here, rendered so it does not pretend to be one that can. */
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
