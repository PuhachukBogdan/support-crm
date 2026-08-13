'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState } from '@/components/composites/states';
import { ComingSoonBadge } from '@/features/inbox/coming-soon';
import { useSession } from '@/session';
import type { MacroWire } from '@/features/ticket/types';
import { useMacrosAdmin, type NewMacroAction } from './use-macros-admin';

/**
 * ⭐⭐ W29 (R46) — ONE screen, three tabs: «Макросы» works, «Автоматизации» and «Триггеры» say
 * Coming Soon and NOTHING ELSE. The operator's own line drew this boundary: *«делать отдельный
 * движок для их настройки мы пока что не будем… Можно просто написать посередине экрана Coming
 * Soon»* — and macro AUTHORING stayed real because ~97 macros are re-entered BY HAND (no export
 * exists in their Zendesk), and without this screen that re-entry is a database seed.
 *
 * ⛔ The stubs must not pretend: no disabled controls, no grayed forms — a sentence saying what
 * this will be, and when the line falls (out of MVP). A placeholder that looks like a broken form
 * is worse than one that admits it is a promise.
 *
 * Authoring is `crm.templates.manage` (supervisors); an agent who lands here gets the refusal IN
 * WORDS — the same sentence the server's 403 means, said before they fill a form that cannot save.
 */
export function MacrosAdmin() {
  const session = useSession();
  const mayAuthor =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('crm.templates.manage');
  const [tab, setTab] = useState<'macros' | 'automations' | 'triggers'>('macros');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 overflow-y-auto py-2">
      <header>
        <h1 className="text-lg font-semibold">Macros, automations &amp; triggers</h1>
        <p className="text-sm text-muted-foreground">
          The bundles agents apply, and the two engines that will someday run without them.
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="macros" data-testid="tab-macros">
            Macros
          </TabsTrigger>
          <TabsTrigger value="automations" data-testid="tab-automations">
            Automations
          </TabsTrigger>
          <TabsTrigger value="triggers" data-testid="tab-triggers">
            Triggers
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'macros' &&
        (mayAuthor ? (
          <MacrosTab />
        ) : (
          // ⭐ The refusal IN WORDS («отказ словами, не пустым экраном») — applying stays theirs,
          // authoring does not, and the sentence says which and why.
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground" data-testid="authoring-denied">
            Applying macros is every agent’s tool — it lives in the ticket window’s composer.
            Writing them is a supervisor’s task (<span className="font-mono">crm.templates.manage</span>),
            and this session does not hold it.
          </p>
        ))}

      {tab === 'automations' && (
        <Stub
          testId="automations-stub"
          what="Automations"
          sentence="Rules that react to a ticket without a person — the engine exists and runs; the screen to configure it is outside the MVP."
        />
      )}
      {tab === 'triggers' && (
        <Stub
          testId="triggers-stub"
          what="Triggers"
          sentence="Event-driven rules (a message arrives → something happens). Out of the MVP; the operator drew this line himself on 07.08."
        />
      )}
    </div>
  );
}

/** The stub: a sentence, a badge, and deliberately not one control. */
function Stub({ testId, what, sentence }: { testId: string; what: string; sentence: string }) {
  return (
    <div
      className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-8 text-center"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {what}
        <ComingSoonBadge />
      </div>
      <p className="max-w-md text-sm text-muted-foreground">{sentence}</p>
    </div>
  );
}

const ACTION_LABELS: Record<NewMacroAction['type'], string> = {
  set_status: 'Set status',
  set_priority: 'Set priority',
  set_category: 'Set category',
  set_sub_category: 'Set sub-category',
};
const PRIORITIES = ['low', 'normal', 'high'] as const;

function MacrosTab() {
  const a = useMacrosAdmin();
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Macros</h2>
        {!creating && (
          <Button size="sm" data-testid="macro-new" onClick={() => setCreating(true)}>
            New macro
          </Button>
        )}
      </div>

      {creating && (
        <CreateForm
          statuses={a.statuses}
          groups={a.groups.status === 'ready' ? a.groups.data.items : null}
          busy={a.busy}
          onCreate={async (input) => {
            if (await a.create(input)) setCreating(false);
          }}
          onDone={() => setCreating(false)}
        />
      )}

      {a.mutation && (
        <p className="text-sm text-destructive" data-testid="macros-error">
          {a.mutation.message}
        </p>
      )}

      {a.macros.status === 'loading' && <Skeleton className="h-24 w-full" />}
      {a.macros.status === 'error' && <ErrorState error={a.macros.error} onRetry={a.refresh} />}
      {a.macros.status === 'empty' && (
        <p className="text-sm text-muted-foreground" data-testid="macros-empty">
          No macros yet — the ~97 from Zendesk arrive through this form, one honest entry at a time.
        </p>
      )}
      {a.macros.status === 'ready' && (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="macros-list">
          {a.macros.data.items.map((m) => (
            <MacroRow key={m.id} macro={m} busy={a.busy} onRemove={() => void a.remove(m.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function MacroRow({
  macro,
  busy,
  onRemove,
}: {
  macro: MacroWire;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start gap-3 p-3 text-sm" data-testid={`macro-${macro.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{macro.name}</span>
          {(macro.groupIds?.length ?? 0) > 0 && (
            <Badge variant="outline" data-testid={`macro-scoped-${macro.id}`}>
              {macro.groupIds!.length} group{macro.groupIds!.length > 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        {macro.text && <p className="mt-0.5 truncate text-xs text-muted-foreground">{macro.text}</p>}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {macro.actions.length === 0
            ? 'no runnable actions (names a retired value?)'
            : macro.actions.map((x) => x.type.replace('MACRO_ACTION_TYPE_', '').toLowerCase()).join(' · ')}
        </p>
      </div>
      {/* The operator's counter: applications in the last 7 days — a number, from rows, per week. */}
      <span className="shrink-0 text-xs text-muted-foreground" data-testid={`macro-usage-${macro.id}`}>
        {macro.appliedLast7 ?? 0}× / 7d
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${macro.name}`}
        data-testid={`macro-delete-${macro.id}`}
        disabled={busy}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </li>
  );
}

function CreateForm({
  statuses,
  groups,
  busy,
  onCreate,
  onDone,
}: {
  statuses: { key: string; agentName: string }[];
  groups: { id: string; name: string }[] | null;
  busy: boolean;
  onCreate: (input: { name: string; text: string; groupIds: string[]; actions: NewMacroAction[] }) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [groupIds, setGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [actions, setActions] = useState<NewMacroAction[]>([]);

  const addAction = (type: NewMacroAction['type']) =>
    setActions((prev) => [...prev, { type, value: type === 'set_priority' ? 'normal' : '' }]);
  const setValue = (i: number, value: string) =>
    setActions((prev) => prev.map((x, j) => (j === i ? { ...x, value } : x)));
  const removeAction = (i: number) => setActions((prev) => prev.filter((_, j) => j !== i));

  const valid = name.trim() !== '' && actions.length > 0 && actions.every((x) => x.value.trim() !== '');

  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      data-testid="macro-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ name: name.trim(), text: text.trim(), groupIds: [...groupIds], actions });
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Macro name — what an agent sees in the picker"
        aria-label="Macro name"
        data-testid="macro-name"
      />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Reply text (optional) — inserted into the composer; the agent still reads and sends it"
        aria-label="Macro reply text"
        data-testid="macro-text"
        rows={3}
      />

      <div className="space-y-2">
        {actions.map((x, i) => (
          <div key={i} className="flex items-center gap-2" data-testid={`action-row-${i}`}>
            <span className="w-36 shrink-0 text-xs text-muted-foreground">{ACTION_LABELS[x.type]}</span>
            {x.type === 'set_status' ? (
              <select
                value={x.value}
                onChange={(e) => setValue(i, e.target.value)}
                aria-label="Status"
                data-testid={`action-value-${i}`}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">— pick a status —</option>
                {statuses.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.agentName}
                  </option>
                ))}
              </select>
            ) : x.type === 'set_priority' ? (
              <select
                value={x.value}
                onChange={(e) => setValue(i, e.target.value)}
                aria-label="Priority"
                data-testid={`action-value-${i}`}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={x.value}
                onChange={(e) => setValue(i, e.target.value)}
                aria-label={ACTION_LABELS[x.type]}
                data-testid={`action-value-${i}`}
                className="h-8"
              />
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => removeAction(i)} aria-label="Remove action">
              ✕
            </Button>
          </div>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" data-testid="macro-add-action">
              + Add action
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(Object.keys(ACTION_LABELS) as NewMacroAction['type'][]).map((t) => (
              <DropdownMenuItem key={t} data-testid={`add-${t}`} onSelect={() => addAction(t)}>
                {ACTION_LABELS[t]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* «Кому доступен»: group scoping — admins only (the groups read is platform.group.manage).
          For a teamlead the picker is ABSENT, not broken: their macros are simply unscoped. */}
      {groups && groups.length > 0 && (
        <fieldset className="space-y-1" data-testid="macro-groups">
          <legend className="text-xs font-medium text-muted-foreground">
            Available to (empty = every agent)
          </legend>
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={groupIds.has(g.id)}
                onCheckedChange={() =>
                  setGroupIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    return next;
                  })
                }
                aria-label={`Available to ${g.name}`}
              />
              {g.name}
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid} data-testid="macro-save">
          Create macro
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </form>
  );
}
