'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/composites/states';
import { useSession } from '@/session';
import type { BrandWire } from '@/features/contacts/types';
import {
  FIELD_TYPES,
  fieldTypeBadge,
  type FieldBody,
  type FieldConfigWire,
  type FieldDefWire,
  type FormBody,
  type FormEntryWire,
  type FormWire,
  type OptionSetBody,
  type OptionSetWire,
} from './types';
import { useTicketFields } from './use-ticket-fields';

/**
 * ⭐ W30 (спек №1, roadmap 4.15) — the «Ticket fields» section of the admin center: fields, option
 * sets and forms, all account DATA. This screen is where the operator re-creates his Zendesk
 * taxonomy himself (the capture never carried the full option lists — they land here), and nothing
 * an admin does on it requires a code change.
 *
 * Authoring is `platform.field.manage`; a session without it gets the refusal IN WORDS — the same
 * sentence the server's 403 means, said before a form that cannot save (the macros precedent). The
 * gate also short-circuits every read: a 403 storm is not a render strategy (the W28 rule).
 */
export function TicketFields() {
  const session = useSession();
  const mayManage =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('platform.field.manage');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto py-2">
      <header>
        <h1 className="text-lg font-semibold">Ticket fields</h1>
        <p className="text-sm text-muted-foreground">
          The fields agents fill on a ticket, the option sets their drop-downs read, and the forms
          that put them in order.
        </p>
      </header>

      {mayManage ? (
        <Authoring />
      ) : (
        <p
          className="rounded-md border border-border p-4 text-sm text-muted-foreground"
          data-testid="fields-denied"
        >
          Filling these fields happens in the ticket window and is every agent’s work. Shaping them —
          fields, option sets and forms — is an administrator’s task
          (<span className="font-mono">platform.field.manage</span>), and this session does not hold
          it.
        </p>
      )}
    </div>
  );
}

/** A stable empty projection, so the three tabs render their invitations from one shape. */
const EMPTY_CONFIG: FieldConfigWire = { optionSets: [], fields: [], forms: [] };

function Authoring() {
  const a = useTicketFields();
  const [tab, setTab] = useState<'fields' | 'sets' | 'forms'>('fields');
  const cfg = a.config.status === 'ready' ? a.config.data : EMPTY_CONFIG;
  const busy = a.busyKey !== null;

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="fields" data-testid="tab-fields">
            Fields
          </TabsTrigger>
          <TabsTrigger value="sets" data-testid="tab-sets">
            Option sets
          </TabsTrigger>
          <TabsTrigger value="forms" data-testid="tab-forms">
            Forms
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {a.mutation && (
        <p className="text-sm text-destructive" data-testid="fields-mutation-error" role="alert">
          {a.mutation.message}
        </p>
      )}

      {a.config.status === 'loading' && <ConfigSkeleton />}
      {a.config.status === 'error' && <ErrorState error={a.config.error} onRetry={a.refresh} />}
      {(a.config.status === 'ready' || a.config.status === 'empty') && (
        <>
          {tab === 'fields' && (
            <FieldsTab
              cfg={cfg}
              brands={a.brands}
              busy={busy}
              onCreate={a.createField}
              onUpdate={a.updateField}
            />
          )}
          {tab === 'sets' && (
            <SetsTab
              cfg={cfg}
              busy={busy}
              onCreate={a.createSet}
              onUpdate={a.updateSet}
              onDelete={a.removeSet}
            />
          )}
          {tab === 'forms' && (
            <FormsTab cfg={cfg} busy={busy} onCreate={a.createForm} onUpdate={a.updateForm} />
          )}
        </>
      )}
    </>
  );
}

/** Skeleton in the SHAPE of the content (§4): a tab header row, then list rows — never a blank. */
function ConfigSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="space-y-px overflow-hidden rounded-md border border-border">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}

/** The one class string for the screen's native selects (the macros-admin precedent, :275). */
const SELECT_CLASS = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

/** The inline editors ARRIVE — one of the four motion moments, on the tokens that exist. */
const EDITOR_CLASS =
  'space-y-3 rounded-md border border-border p-3 animate-in fade-in-0 slide-in-from-top-1 duration-base ease-standard motion-reduce:animate-none';

/** Row buttons share the hover moment: colors only, `--motion-fast`. */
const ROW_CLASS =
  'flex w-full items-center gap-2 p-3 text-left text-sm transition-colors duration-fast ease-standard hover:bg-muted/50 motion-reduce:transition-none';

// ═══ Fields ═══════════════════════════════════════════════════════════════════════════════════════

function FieldsTab({
  cfg,
  brands,
  busy,
  onCreate,
  onUpdate,
}: {
  cfg: FieldConfigWire;
  brands: BrandWire[];
  busy: boolean;
  onCreate: (body: FieldBody) => Promise<boolean>;
  onUpdate: (key: string, body: FieldBody) => Promise<boolean>;
}) {
  /** `'new'` or a field key — one editor open at a time, the row click is the toggle. */
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Fields</h2>
        {editing !== 'new' && (
          <Button size="sm" data-testid="field-new" onClick={() => setEditing('new')}>
            New field
          </Button>
        )}
      </div>

      {editing === 'new' && (
        <FieldEditor
          optionSets={cfg.optionSets}
          brands={brands}
          busy={busy}
          onSave={async (body) => {
            if (await onCreate(body)) setEditing(null);
          }}
          onDone={() => setEditing(null)}
        />
      )}

      {cfg.fields.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="fields-empty">
          No fields yet. The Zendesk capture holds ~65 of them — each one is re-created here as
          data, never as code. «New field» is the whole ceremony.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="fields-list"
        >
          {cfg.fields.map((f) => (
            <li key={f.key} data-testid={`field-${f.key}`}>
              <button
                type="button"
                className={ROW_CLASS}
                data-testid={`field-open-${f.key}`}
                aria-expanded={editing === f.key}
                onClick={() => setEditing(editing === f.key ? null : f.key)}
              >
                <span
                  className={`truncate font-medium ${f.active ? '' : 'text-muted-foreground line-through'}`}
                >
                  {f.label}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">{f.key}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Badge variant="outline">{fieldTypeBadge(f.type)}</Badge>
                  {f.required && <Badge variant="outline">required</Badge>}
                  {f.restricted && <Badge variant="outline">restricted</Badge>}
                  {f.brandIds.length > 0 && (
                    <Badge variant="outline">
                      {f.brandIds.length} brand{f.brandIds.length > 1 ? 's' : ''}
                    </Badge>
                  )}
                  {!f.active && <Badge variant="secondary">archived</Badge>}
                </span>
              </button>
              {editing === f.key && (
                <div className="border-t border-border p-3">
                  <FieldEditor
                    existing={f}
                    optionSets={cfg.optionSets}
                    brands={brands}
                    busy={busy}
                    onSave={async (body) => {
                      if (await onUpdate(f.key, body)) setEditing(null);
                    }}
                    onDone={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FieldEditor({
  existing,
  optionSets,
  brands,
  busy,
  onSave,
  onDone,
}: {
  existing?: FieldDefWire;
  optionSets: OptionSetWire[];
  brands: BrandWire[];
  busy: boolean;
  onSave: (body: FieldBody) => void;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [type, setType] = useState(existing?.type ?? 'text');
  const [required, setRequired] = useState(existing?.required ?? false);
  const [restricted, setRestricted] = useState(existing?.restricted ?? false);
  const [optionSetId, setOptionSetId] = useState(existing?.optionSetId ?? '');
  const [brandIds, setBrandIds] = useState<ReadonlySet<string>>(new Set(existing?.brandIds ?? []));

  const isDropdown = type === 'dropdown';
  const valid = label.trim() !== '' && (!isDropdown || optionSetId !== '');

  // PATCH carries the WHOLE body (the repository overwrites, never merges) — including the same
  // type, which the server accepts; only a CHANGED type is refused.
  const body = (active: boolean): FieldBody => ({
    label: label.trim(),
    type,
    required,
    restricted,
    optionSetId: isDropdown ? optionSetId : '',
    brandIds: [...brandIds],
    active,
  });

  // Archive/restore states the row the SERVER holds, not the half-edited form — flipping `active`
  // must never smuggle an unsaved label along with it.
  const archiveBody = (): FieldBody => ({
    label: existing!.label,
    type: existing!.type,
    required: existing!.required,
    restricted: existing!.restricted,
    optionSetId: existing!.optionSetId,
    brandIds: existing!.brandIds,
    active: !existing!.active,
  });

  return (
    <form
      className={EDITOR_CLASS}
      data-testid="field-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(body(existing?.active ?? true));
      }}
    >
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Field label — what agents see on the ticket"
        aria-label="Field label"
        data-testid="field-label"
        autoFocus
      />

      {existing ? (
        // The type is the value rows' identity: the server refuses a change, so the editor states
        // it instead of offering a control that cannot succeed.
        <p className="text-xs text-muted-foreground">
          Type: <span className="font-medium text-foreground">{fieldTypeBadge(existing.type)}</span>{' '}
          — fixed once created; archive this field and create a new one to change it.
        </p>
      ) : (
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="Field type"
          data-testid="field-type"
          className={`${SELECT_CLASS} w-full`}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      )}

      {isDropdown &&
        (optionSets.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="field-no-sets">
            A drop-down reads its values from an option set — create one on the «Option sets» tab
            first.
          </p>
        ) : (
          <select
            value={optionSetId}
            onChange={(e) => setOptionSetId(e.target.value)}
            aria-label="Option set"
            data-testid="field-option-set"
            className={`${SELECT_CLASS} w-full`}
          >
            <option value="">— pick an option set —</option>
            {optionSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ))}

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={required}
            onCheckedChange={() => setRequired((v) => !v)}
            aria-label="Required to solve"
            data-testid="field-required"
          />
          Required to solve
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={restricted}
            onCheckedChange={() => setRestricted((v) => !v)}
            aria-label="Restricted visibility"
            data-testid="field-restricted"
          />
          Restricted — absent for uncleared roles, not blank
        </label>
      </div>

      {/* Per-brand applicability is DATA (rule 6). The picker degrades ALONE: no brands read, no
          picker — the field simply applies everywhere, which is also what empty means. */}
      {brands.length > 0 && (
        <fieldset className="space-y-1" data-testid="field-brands">
          <legend className="text-xs font-medium text-muted-foreground">
            Applies to (empty = every brand)
          </legend>
          {brands.map((b) => (
            <label key={b.brandId} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={brandIds.has(b.brandId)}
                onCheckedChange={() =>
                  setBrandIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(b.brandId)) next.delete(b.brandId);
                    else next.add(b.brandId);
                    return next;
                  })
                }
                aria-label={`Applies to ${b.name}`}
              />
              {b.name}
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} data-testid="field-save">
          {existing ? 'Save field' : 'Create field'}
        </Button>
        {existing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="field-archive"
            onClick={() => onSave(archiveBody())}
          >
            {existing.active ? 'Archive' : 'Restore'}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </form>
  );
}

// ═══ Option sets ══════════════════════════════════════════════════════════════════════════════════

function SetsTab({
  cfg,
  busy,
  onCreate,
  onUpdate,
  onDelete,
}: {
  cfg: FieldConfigWire;
  busy: boolean;
  onCreate: (body: OptionSetBody) => Promise<boolean>;
  onUpdate: (id: string, body: OptionSetBody) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const usedBy = (id: string) => cfg.fields.filter((f) => f.optionSetId === id).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Option sets</h2>
        {editing !== 'new' && (
          <Button size="sm" data-testid="set-new" onClick={() => setEditing('new')}>
            New option set
          </Button>
        )}
      </div>

      {editing === 'new' && (
        <SetEditor
          busy={busy}
          usedBy={0}
          onSave={async (body) => {
            if (await onCreate(body)) setEditing(null);
          }}
          onDone={() => setEditing(null)}
        />
      )}

      {cfg.optionSets.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="sets-empty">
          No option sets yet. A drop-down field reads its values from a set — the capture never
          carried the full lists, so this is where they are typed in.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="sets-list"
        >
          {cfg.optionSets.map((s) => {
            const retired = s.values.filter((v) => !v.active).length;
            const referencing = usedBy(s.id);
            return (
              <li key={s.id} data-testid={`set-${s.id}`}>
                <button
                  type="button"
                  className={ROW_CLASS}
                  data-testid={`set-open-${s.id}`}
                  aria-expanded={editing === s.id}
                  onClick={() => setEditing(editing === s.id ? null : s.id)}
                >
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.values.length} value{s.values.length === 1 ? '' : 's'}
                    {retired > 0 ? ` · ${retired} retired` : ''}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {referencing > 0 && (
                      <Badge variant="outline">
                        used by {referencing} field{referencing > 1 ? 's' : ''}
                      </Badge>
                    )}
                  </span>
                </button>
                {editing === s.id && (
                  <div className="border-t border-border p-3">
                    <SetEditor
                      existing={s}
                      usedBy={referencing}
                      busy={busy}
                      onSave={async (body) => {
                        if (await onUpdate(s.id, body)) setEditing(null);
                      }}
                      onDelete={async () => {
                        if (await onDelete(s.id)) setEditing(null);
                      }}
                      onDone={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SetEditor({
  existing,
  usedBy,
  busy,
  onSave,
  onDelete,
  onDone,
}: {
  existing?: OptionSetWire;
  /** How many fields reference this set — said in the delete confirmation, in words. */
  usedBy: number;
  busy: boolean;
  onSave: (body: OptionSetBody) => void;
  onDelete?: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [values, setValues] = useState<{ value: string; active: boolean }[]>(
    existing
      ? [...existing.values].sort((a, b) => a.order - b.order).map((v) => ({ value: v.value, active: v.active }))
      : [{ value: '', active: true }],
  );

  const valid = name.trim() !== '' && values.length > 0 && values.every((v) => v.value.trim() !== '');

  return (
    <form
      className={EDITOR_CLASS}
      data-testid="set-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          onSave({
            name: name.trim(),
            values: values.map((v, i) => ({ value: v.value.trim(), order: i, active: v.active })),
          });
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Set name — e.g. the list a drop-down offers"
        aria-label="Option set name"
        data-testid="set-name"
        autoFocus
      />

      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-2" data-testid={`set-value-row-${i}`}>
            <Input
              value={v.value}
              onChange={(e) =>
                setValues((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
              aria-label={`Value ${i + 1}`}
              data-testid={`set-value-${i}`}
              className="h-8"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={v.active}
                onCheckedChange={() =>
                  setValues((prev) => prev.map((x, j) => (j === i ? { ...x, active: !x.active } : x)))
                }
                aria-label={`Value ${i + 1} active`}
                data-testid={`set-value-active-${i}`}
              />
              active
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove value ${i + 1}`}
              data-testid={`set-value-remove-${i}`}
              onClick={() => setValues((prev) => prev.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="set-add-value"
          onClick={() => setValues((prev) => [...prev, { value: '', active: true }])}
        >
          + Add value
        </Button>
      </div>

      {/* The save sends the WHOLE list; the server diffs. Saying the deletion rule up front spares
          the admin a refusal they could not have predicted. */}
      <p className="text-xs text-muted-foreground">
        Removing a row deletes the value only while no ticket holds it — otherwise the server
        refuses in words; untick «active» to retire it instead.
      </p>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} data-testid="set-save">
          {existing ? 'Save set' : 'Create set'}
        </Button>
        {existing && onDelete && (
          <DeleteSetButton name={existing.name} usedBy={usedBy} busy={busy} onDelete={onDelete} />
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </form>
  );
}

/** The destructive confirm IN WORDS — Alert Dialog from the library, not a hand-made overlay. */
function DeleteSetButton({
  name,
  usedBy,
  busy,
  onDelete,
}: {
  name: string;
  usedBy: number;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="set-delete">
          Delete set
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete «{name}»?</AlertDialogTitle>
          <AlertDialogDescription>
            The whole value list goes with it.{' '}
            {usedBy > 0
              ? `The server will refuse: ${usedBy} field${usedBy > 1 ? 's' : ''} still read${usedBy > 1 ? '' : 's'} from this set.`
              : 'No field references this set today, so the server will allow it.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction data-testid="set-delete-confirm" onClick={onDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ═══ Forms ════════════════════════════════════════════════════════════════════════════════════════

function FormsTab({
  cfg,
  busy,
  onCreate,
  onUpdate,
}: {
  cfg: FieldConfigWire;
  busy: boolean;
  onCreate: (body: FormBody) => Promise<boolean>;
  onUpdate: (key: string, body: FormBody) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Forms</h2>
        {editing !== 'new' && (
          <Button size="sm" data-testid="form-new" onClick={() => setEditing('new')}>
            New form
          </Button>
        )}
      </div>

      {editing === 'new' && (
        <FormEditor
          fields={cfg.fields}
          optionSets={cfg.optionSets}
          formsCount={cfg.forms.length}
          busy={busy}
          onSave={async (body) => {
            if (await onCreate(body)) setEditing(null);
          }}
          onDone={() => setEditing(null)}
        />
      )}

      {cfg.forms.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="forms-empty">
          No forms yet. A form is the ordered list of fields agents see on a ticket — the capture
          names twelve, Deposits and Account among them, and each is composed here.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="forms-list"
        >
          {cfg.forms.map((f) => (
            <li key={f.key} data-testid={`form-${f.key}`}>
              <button
                type="button"
                className={ROW_CLASS}
                data-testid={`form-open-${f.key}`}
                aria-expanded={editing === f.key}
                onClick={() => setEditing(editing === f.key ? null : f.key)}
              >
                <span
                  className={`truncate font-medium ${f.active ? '' : 'text-muted-foreground line-through'}`}
                >
                  {f.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.entries.length} field{f.entries.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {f.category !== '' && <Badge variant="outline">→ {f.category}</Badge>}
                  {!f.active && <Badge variant="secondary">archived</Badge>}
                </span>
              </button>
              {editing === f.key && (
                <div className="border-t border-border p-3">
                  <FormEditor
                    existing={f}
                    fields={cfg.fields}
                    optionSets={cfg.optionSets}
                    formsCount={cfg.forms.length}
                    busy={busy}
                    onSave={async (body) => {
                      if (await onUpdate(f.key, body)) setEditing(null);
                    }}
                    onDone={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface EntryDraft {
  fieldKey: string;
  conditionFieldKey: string;
  conditionValue: string;
  isSubcategorySource: boolean;
}

function FormEditor({
  existing,
  fields,
  optionSets,
  formsCount,
  busy,
  onSave,
  onDone,
}: {
  existing?: FormWire;
  fields: FieldDefWire[];
  optionSets: OptionSetWire[];
  formsCount: number;
  busy: boolean;
  onSave: (body: FormBody) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [category, setCategory] = useState(existing?.category ?? '');
  const [entries, setEntries] = useState<EntryDraft[]>(
    existing
      ? [...existing.entries]
          .sort((a, b) => a.order - b.order)
          .map((e) => ({
            fieldKey: e.fieldKey,
            conditionFieldKey: e.conditionFieldKey,
            conditionValue: e.conditionValue,
            isSubcategorySource: e.isSubcategorySource,
          }))
      : [],
  );

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const isDropdownKey = (key: string) => fieldByKey.get(key)?.type === 'dropdown';

  // The picker offers only ACTIVE fields not already on the form; an archived field already ON the
  // form keeps rendering (values on conversations outlive authoring acts) but is never re-offered.
  const addable = fields.filter((f) => f.active && !entries.some((e) => e.fieldKey === f.key));

  /** Condition parents for entry `i`: the OTHER dropdown entries of THIS form — nothing else. */
  const parentsFor = (i: number) =>
    entries.filter((e, j) => j !== i && isDropdownKey(e.fieldKey));

  /** Active values of the parent's option set — the condition value is picked, never typed. */
  const parentValues = (parentKey: string) => {
    const set = optionSets.find((s) => s.id === fieldByKey.get(parentKey)?.optionSetId);
    return set ? [...set.values].sort((a, b) => a.order - b.order).filter((v) => v.active) : [];
  };

  const move = (i: number, delta: -1 | 1) =>
    setEntries((prev) => {
      const j = i + delta;
      const a = prev[i];
      const b = prev[j];
      if (!a || !b) return prev;
      const next = [...prev];
      next[i] = b;
      next[j] = a;
      return next;
    });

  const removeEntry = (i: number) =>
    setEntries((prev) => {
      const removedKey = prev[i]?.fieldKey;
      // A dependent's parent left the form — clear the condition in the same act, so the editor
      // never proposes a form the server must refuse (the FR-004 rule, said client-side).
      return prev
        .filter((_, j) => j !== i)
        .map((e) =>
          e.conditionFieldKey === removedKey ? { ...e, conditionFieldKey: '', conditionValue: '' } : e,
        );
    });

  const setSource = (index: number | null) =>
    setEntries((prev) => prev.map((e, j) => ({ ...e, isSubcategorySource: j === index })));

  const hasDropdownEntry = entries.some((e) => isDropdownKey(e.fieldKey));
  const valid =
    name.trim() !== '' &&
    entries.every((e) => e.conditionFieldKey === '' || e.conditionValue !== '');

  // Radios need a name; scope it to the form so two editors could never capture each other.
  const radioName = `subcategory-source-${existing?.key ?? 'new'}`;

  return (
    <form
      className={EDITOR_CLASS}
      data-testid="form-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          onSave({
            name: name.trim(),
            category: category.trim(),
            active: existing?.active ?? true,
            order: existing?.order ?? formsCount,
            entries: entries.map((e2, i) => ({ ...e2, order: i }) satisfies FormEntryWire),
          });
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Form name — what agents pick on the ticket"
        aria-label="Form name"
        data-testid="form-name"
        autoFocus
      />
      <Input
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="Category (optional) — choosing this form files the ticket under it"
        aria-label="Form category"
        data-testid="form-category"
      />

      {entries.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {entries.map((e, i) => {
            const def = fieldByKey.get(e.fieldKey);
            const label = def?.label ?? e.fieldKey;
            const parents = parentsFor(i);
            return (
              <li key={e.fieldKey} className="space-y-2 p-2" data-testid={`form-entry-${i}`}>
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {label}
                    {def && !def.active && (
                      <Badge variant="secondary" className="ml-2">
                        archived
                      </Badge>
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${label} up`}
                    data-testid={`entry-up-${i}`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move ${label} down`}
                    data-testid={`entry-down-${i}`}
                    disabled={i === entries.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${label} from the form`}
                    data-testid={`entry-remove-${i}`}
                    onClick={() => removeEntry(i)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  {parents.length > 0 && (
                    <label className="flex items-center gap-1.5">
                      Shown when
                      <select
                        value={e.conditionFieldKey}
                        onChange={(ev) =>
                          setEntries((prev) =>
                            prev.map((x, j) =>
                              j === i
                                ? { ...x, conditionFieldKey: ev.target.value, conditionValue: '' }
                                : x,
                            ),
                          )
                        }
                        aria-label={`Condition parent for ${label}`}
                        data-testid={`entry-condition-${i}`}
                        className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
                      >
                        <option value="">always</option>
                        {parents.map((p) => (
                          <option key={p.fieldKey} value={p.fieldKey}>
                            {fieldByKey.get(p.fieldKey)?.label ?? p.fieldKey}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {e.conditionFieldKey !== '' && (
                    <label className="flex items-center gap-1.5">
                      =
                      <select
                        value={e.conditionValue}
                        onChange={(ev) =>
                          setEntries((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, conditionValue: ev.target.value } : x)),
                          )
                        }
                        aria-label={`Condition value for ${label}`}
                        data-testid={`entry-condition-value-${i}`}
                        className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
                      >
                        <option value="">— pick a value —</option>
                        {parentValues(e.conditionFieldKey).map((v) => (
                          <option key={v.value} value={v.value}>
                            {v.value}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {/* Only a dropdown may classify — the UI never offers the impossible (FR-005). */}
                  {isDropdownKey(e.fieldKey) && (
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={radioName}
                        checked={e.isSubcategorySource}
                        onChange={() => setSource(i)}
                        aria-label={`${label} is the sub-category source`}
                        data-testid={`entry-source-${i}`}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      sub-category source
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasDropdownEntry && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="radio"
            name={radioName}
            checked={!entries.some((e) => e.isSubcategorySource)}
            onChange={() => setSource(null)}
            aria-label="No sub-category source"
            data-testid="entry-source-none"
            className="h-3.5 w-3.5 accent-primary"
          />
          no sub-category source — the form only sets its category
        </label>
      )}

      {addable.length > 0 ? (
        <select
          value=""
          onChange={(ev) => {
            const key = ev.target.value;
            if (key)
              setEntries((prev) => [
                ...prev,
                { fieldKey: key, conditionFieldKey: '', conditionValue: '', isSubcategorySource: false },
              ]);
          }}
          aria-label="Add a field to the form"
          data-testid="form-add-field"
          className={SELECT_CLASS}
        >
          <option value="">+ Add a field…</option>
          {addable.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-xs text-muted-foreground">
          {fields.some((f) => f.active)
            ? 'Every active field is already on this form.'
            : 'No active fields yet — create them on the «Fields» tab first.'}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} data-testid="form-save">
          {existing ? 'Save form' : 'Create form'}
        </Button>
        {existing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="form-archive"
            onClick={() =>
              // Same rule as fields: archive/restore flips `active` on the row the server holds.
              onSave({
                name: existing.name,
                category: existing.category,
                active: !existing.active,
                order: existing.order,
                entries: [...existing.entries]
                  .sort((a, b) => a.order - b.order)
                  .map((e, i) => ({ ...e, order: i })),
              })
            }
          >
            {existing.active ? 'Archive' : 'Restore'}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </form>
  );
}
