'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { EditableChoice, EditableText } from './editable';
import { useConversationFields, type FieldEntryWire } from './use-conversation-fields';

/**
 * ⭐ W30 (roadmap 4.15 — frame `032-ticket-fields-left-column`): the custom-fields block the
 * column's header reserved a spot for since W7.
 *
 * ── What renders is the SERVER's answer, twice over ──────────────────────────────────────────────
 * The view arrives already resolved per caller — a restricted field is ABSENT from the payload, so
 * this block cannot leak what it never receives (US3), and brand applicability was filtered where
 * the data lives. The only client-side judgement is the CONDITION (show L2 while L1 = its value):
 * that must react to the choice before the round-trip, and the server re-validates every write
 * anyway — render-only, like every permission gate on this screen.
 *
 * ── The cascade clears on the SERVER, visibly ────────────────────────────────────────────────────
 * Changing L1 hides L2/L3 locally at once (the condition stops holding) and the write's re-read
 * brings back the truth: the server cleared those values in the same transaction, so what came back
 * is what is stored — never a hidden stale value waiting for the parent to flip back.
 *
 * ── Empty states, told apart ─────────────────────────────────────────────────────────────────────
 * No forms configured at all ⇒ the block renders NOTHING (an absent capability reads as "not set
 * up" — the composer's rule). Forms exist but none chosen ⇒ the selector alone. A failed view read
 * degrades ALONE with a retry — an annotation must never take the window with it (TagsBlock's rule).
 */
export function CustomFieldsBlock({ conversationId }: { conversationId: string }) {
  const { view, busyKey, mutationError, refresh, setForm, setValue, clearValue, valueOf } =
    useConversationFields(conversationId);

  if (view.status === 'idle' || view.status === 'loading') {
    return (
      <div className="space-y-3 border-t border-border pt-4" data-testid="custom-fields-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (view.status === 'error') {
    return (
      <div className="border-t border-border pt-4" data-testid="custom-fields-error-state">
        <p className="text-xs text-muted-foreground">
          Ticket fields are unavailable right now.{' '}
          <button type="button" onClick={refresh} className="text-primary hover:underline">
            Retry
          </button>
        </p>
      </div>
    );
  }
  // 'empty' is a list-shaped state this singleton read never produces; treated as not-yet-here.
  if (view.status !== 'ready') return null;

  const { formKey, entries, availableForms } = view.data;
  // Nothing configured, nothing chosen: silently absent — the admin screen is where this begins.
  if (availableForms.length === 0 && !formKey && entries.length === 0) return null;

  const formOptions = availableForms.map((f) => ({ value: f.key, label: f.name }));
  const conditionHolds = (e: FieldEntryWire): boolean =>
    !e.conditionFieldKey || valueOf(e.conditionFieldKey) === e.conditionValue;
  const visible = [...entries].sort((a, b) => a.order - b.order).filter(conditionHolds);

  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="custom-fields">
      <div>
        <div className="text-xs font-medium text-muted-foreground">Form</div>
        <EditableChoice
          value={formKey}
          options={formOptions}
          placeholder="No form"
          onCommit={setForm}
          disabled={busyKey !== null}
          ariaLabel="Form"
          testId="field-form"
          // Un-filing is a real state (every ticket starts there); stored values survive a clear.
          allowClear
          clearLabel="No form"
        />
      </div>
      {visible.map((e) => (
        <FieldRow
          key={e.field.key}
          entry={e}
          value={valueOf(e.field.key)}
          busy={busyKey !== null}
          onCommit={(v) => (v === '' ? clearValue(e.field.key) : setValue(e.field.key, v))}
        />
      ))}
      {/* ⭐ The WORDS of the solve gate live HERE, proactively: the REST edge is message-free by
          the product's own SC-007 rule (the gateway flattens refusal detail), so the server's
          refusal names nothing the screen can echo — the screen derives the same list from the
          same facts instead, and the agent reads it before the refusal, not after. */}
      {(() => {
        const missing = visible.filter((e) => e.field.required && valueOf(e.field.key) === '');
        return missing.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="custom-fields-required-hint">
            Required to solve: {missing.map((e) => e.field.label).join(', ')}
          </p>
        ) : null;
      })()}
      {mutationError && (
        <p className="text-xs text-destructive" data-testid="custom-fields-error">
          {mutationError.message}
        </p>
      )}
    </div>
  );
}

/**
 * One field, rendered by its TYPE — the closed vocabulary is the only thing this switch reads
 * (branching on a field KEY is the defect `tests/fields` scans for). A deactivated value a ticket
 * still holds is offered back marked, never hidden: history must render (spec edge case).
 */
function FieldRow({
  entry,
  value,
  busy,
  onCommit,
}: {
  entry: FieldEntryWire;
  value: string;
  busy: boolean;
  onCommit: (value: string) => void;
}) {
  const f = entry.field;
  const label = f.required ? `${f.label} *` : f.label;
  return (
    <div data-testid={`cf-${f.key}`}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {f.type === 'dropdown' ? (
        <EditableChoice
          value={value}
          options={entry.options.map((o) => ({
            value: o.value,
            label: o.active ? o.value : `${o.value} (inactive)`,
          }))}
          placeholder="—"
          onCommit={onCommit}
          disabled={busy}
          ariaLabel={f.label}
          testId={`cf-input-${f.key}`}
          // Required gates SOLVE, not editing (D4) — clearing stays reachable everywhere.
          allowClear
          clearLabel="—"
        />
      ) : (
        <EditableText
          value={value}
          placeholder={f.type === 'numeric' ? 'Add a number' : 'Add a value'}
          onCommit={onCommit}
          disabled={busy}
          ariaLabel={f.label}
          testId={`cf-input-${f.key}`}
          className={f.type === 'numeric' ? 'font-mono' : undefined}
        />
      )}
    </div>
  );
}
