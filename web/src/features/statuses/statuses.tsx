'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/composites/page-header/page-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DataError } from '@/data/types';
import { useSession } from '@/session';
import { useAdminStatuses } from './use-admin-statuses';
import { STATUS_CATEGORIES, type StatusDef } from './types';

/**
 * W15a — Ticket statuses in the Admin Center (subpoint 3.14; frame `admin-center/068`, proportions
 * not pixels; O6 reversed R21: the screen exists, and it lives HERE, not on the ticket).
 *
 * The frame's shape: rows GROUPED BY CATEGORY, each row carrying the agent-facing and the
 * end-user-facing name — the dual naming ADR 0040 made a column, now editable. Creating a status
 * is an INSERT into an existing category (the whole point of the two-level model); the KEY is
 * derived from the agent name by the server and immutable, so it is shown, never edited.
 *
 * Retiring is `active: false` — the row stays (old tickets keep their label), it stops being
 * settable, and this screen can restore it. ⛔ There is deliberately no DELETE and no reorder:
 * neither is in 3.14's minimum, and delete does not exist server-side at all (ON DELETE RESTRICT).
 */
export function Statuses() {
  const { statuses, create, update } = useAdminStatuses();
  const session = useSession();
  const permissionKeys = session.state.kind === 'authenticated' ? session.state.permissionKeys : [];
  // ⚠️ Unlike the channels screen, the READ here is `crm.inbox.view` — a teamlead legitimately sees
  // the vocabulary their inbox is labelled with. The WRITES are `platform.settings.manage`, so the
  // write controls follow the by-absence rule: render-only (the server refuses regardless), but a
  // control every teamlead can only 403 with is noise.
  const mayManage = permissionKeys.includes('platform.settings.manage');
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader
        title="Ticket statuses"
        actions={
          mayManage && (
            <Button size="sm" data-testid="status-create-open" onClick={() => setCreating((v) => !v)}>
              {creating ? 'Close' : 'Create ticket status'}
            </Button>
          )
        }
      />

      {creating && mayManage && <CreateStatus onCreate={create} />}

      {statuses.status === 'ready' ? (
        <div className="space-y-4">
          {STATUS_CATEGORIES.filter((c) => statuses.data.some((s) => s.category === c)).map((category) => (
            <section key={category} className="space-y-1" data-testid={`category-${category}`}>
              {/* The category is the machine's word and the grouping IS its meaning on this screen —
                  a status moves buckets by moving here, never by code. */}
              <h2 className="text-sm font-semibold">{category}</h2>
              <ul className="divide-y divide-border rounded-md border border-border">
                {statuses.data
                  .filter((s) => s.category === category)
                  .map((s) => (
                    <StatusRow key={s.key} def={s} mayManage={mayManage} onUpdate={update} />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      ) : statuses.status === 'error' ? (
        <p className="text-sm text-destructive" data-testid="statuses-error">
          {statuses.error.message}
        </p>
      ) : statuses.status === 'empty' ? (
        <p className="text-sm text-muted-foreground" data-testid="statuses-empty">
          No statuses are configured for this account yet.
        </p>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </div>
  );
}

function CategoryPicker({
  value,
  onPick,
  testid,
}: {
  value: string;
  onPick: (c: string) => void;
  testid: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" data-testid={testid}>
          {value || 'Choose a category'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {STATUS_CATEGORIES.map((c) => (
          <DropdownMenuItem key={c} onSelect={() => onPick(c)}>
            {c}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Create: category + the two names. The key is the server's — derived from the agent name. */
function CreateStatus({
  onCreate,
}: {
  onCreate: (input: { category: string; agentName: string; endUserName: string }) => Promise<DataError | null>;
}) {
  const [category, setCategory] = useState('');
  const [agentName, setAgentName] = useState('');
  const [endUserName, setEndUserName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const [created, setCreated] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setCreated(false);
    const failure = await onCreate({ category, agentName: agentName.trim(), endUserName: endUserName.trim() });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setCreated(true);
    setAgentName('');
    setEndUserName('');
  };

  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="status-create-form">
      <h2 className="text-sm font-medium">Create a status</h2>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <CategoryPicker value={category} onPick={setCategory} testid="status-create-category" />
        <Input
          required
          placeholder="Agent-facing name"
          className="w-52"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          data-testid="status-create-agent-name"
        />
        <Input
          required
          placeholder="Customer-facing name"
          className="w-52"
          value={endUserName}
          onChange={(e) => setEndUserName(e.target.value)}
          data-testid="status-create-end-user-name"
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy || !category || !agentName.trim() || !endUserName.trim()}
          data-testid="status-create-save"
        >
          Create
        </Button>
      </form>
      {created && (
        <p className="text-sm text-muted-foreground" data-testid="status-create-done">
          Status created — it appears under its category below, and agents can set it right away.
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" data-testid="status-create-error">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** One definition: the two names, the key (small, immutable), retired state, and the inline edit. */
function StatusRow({
  def,
  mayManage,
  onUpdate,
}: {
  def: StatusDef;
  mayManage: boolean;
  onUpdate: (
    key: string,
    patch: { agentName?: string; endUserName?: string; category?: string; active?: boolean },
  ) => Promise<DataError | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [agentName, setAgentName] = useState(def.agentName);
  const [endUserName, setEndUserName] = useState(def.endUserName);
  const [category, setCategory] = useState(def.category);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);

  const openEdit = () => {
    // Re-seed from the CURRENT row — the channels screen's lesson: a once-run initializer offers
    // the value from before the previous save.
    setAgentName(def.agentName);
    setEndUserName(def.endUserName);
    setCategory(def.category);
    setError(null);
    setEditing(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const failure = await onUpdate(def.key, {
      agentName: agentName.trim(),
      endUserName: endUserName.trim(),
      // Sent only when it moved: the server refuses a no-op, and "same category" is not an edit.
      ...(category !== def.category ? { category } : {}),
    });
    setBusy(false);
    if (failure) setError(failure);
    else setEditing(false); // the regrouped list is the receipt
  };

  const toggleActive = async () => {
    setBusy(true);
    setError(null);
    const failure = await onUpdate(def.key, { active: !def.active });
    setBusy(false);
    if (failure) setError(failure);
  };

  return (
    <li className="flex flex-wrap items-center gap-3 p-2 text-sm" data-testid={`status-${def.key}`}>
      {!editing ? (
        <>
          <span className="w-52 shrink-0 truncate font-medium">{def.agentName}</span>
          <span className="w-52 shrink-0 truncate text-muted-foreground" data-testid={`end-user-name-${def.key}`}>
            {def.endUserName}
          </span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{def.key}</code>
          {!def.active && (
            <Badge variant="outline" data-testid={`retired-${def.key}`}>
              retired — not settable, old tickets keep the label
            </Badge>
          )}
          {mayManage && (
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" data-testid={`status-edit-${def.key}`} onClick={openEdit}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} data-testid={`status-toggle-${def.key}`} onClick={() => void toggleActive()}>
                {def.active ? 'Retire' : 'Restore'}
              </Button>
            </span>
          )}
        </>
      ) : (
        <form
          className="flex w-full flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input className="w-52" value={agentName} onChange={(e) => setAgentName(e.target.value)} data-testid={`edit-agent-name-${def.key}`} />
          <Input className="w-52" value={endUserName} onChange={(e) => setEndUserName(e.target.value)} data-testid={`edit-end-user-name-${def.key}`} />
          <CategoryPicker value={category} onPick={setCategory} testid={`edit-category-${def.key}`} />
          <Button type="submit" size="sm" disabled={busy || !agentName.trim() || !endUserName.trim()} data-testid={`status-save-${def.key}`}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && (
        <p className="w-full text-sm text-destructive" data-testid={`status-error-${def.key}`}>
          {error.message}
        </p>
      )}
    </li>
  );
}
