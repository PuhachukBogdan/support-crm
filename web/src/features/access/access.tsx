'use client';

import { useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/composites/states';
import { cn } from '@/lib/utils';
import { useSession } from '@/session';
import { ASSIGNABLE_ROLES, type GroupWire, type StaffWire } from '@/features/people/types';
import type { CatalogueWire, PersonPermissionsWire, Scope } from './types';
import { useAccess } from './use-access';

/**
 * ⭐⭐ W28 (9.8, R45) — ACCESS MANAGEMENT: roles and permissions in ONE window.
 *
 * The operator, twice: *«Управление ролями и доступами должно быть в одном окне… Там выдаются роли,
 * меняются роли, там же выдаются права и убираются права»* — and, naming this screen as the example
 * of the production rule: *«я изначально думал соединить это окно с Access Management… чтобы это
 * всё было компактней, красивей»*. Two screens answered one question; this is the one screen.
 *
 * ── Composition ──────────────────────────────────────────────────────────────────────────────────
 * Left: WHO — three tabs (People · Roles · Groups: the role axis and the group axis are TWO axes,
 * ADR 0039, and the tabs keep them visibly distinct). People multi-select via checkboxes for the
 * batch scope. Right: WHAT — the catalogue as categories → permissions → switches, with search.
 *
 * ── What a switch MEANS, per scope ───────────────────────────────────────────────────────────────
 * · person — the BASE term (snapshot-or-role). A key arriving via membership shows the «via group»
 *   chip instead of pretending the switch controls it (the union is live and grants-only — a
 *   toggle-off would spring back and read as broken).
 * · role — the role's template. Editing it moves everyone still INHERITING it, and says so.
 * · group — the group's own grant rows (PUT/DELETE per key, 0039).
 * · selection — write-only by design: N people have no single truth to render, so the row offers
 *   Grant/Revoke ACTIONS, never a switch pretending to show state (FR-011's single-role constraint
 *   is surfaced before the server's 409).
 *
 * ⛔ super_admin is neither assignable nor editable here (0033 whitelist, FR-018) — the option does
 * not exist on this screen, and the server refuses regardless.
 * ⛔ Non-super-admins do not reach this section: the nav hides it (render courtesy), every route
 * behind it is super-admin-gated at the gateway AND in auth (the enforcement).
 */
export function Access() {
  const session = useSession();
  const isSuperAdmin =
    session.state.kind === 'authenticated' &&
    session.state.permissionKeys.includes('platform.role.manage');

  if (!isSuperAdmin) {
    // The courtesy half of «не открывает ни ссылкой, ни прямым запросом» — the server owns the rest.
    return (
      <div className="mx-auto max-w-lg py-16 text-center" data-testid="access-denied">
        <h1 className="text-lg font-semibold">Access management</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This is a super-admin surface: it decides what everybody else may do. Your session does
          not hold that role.
        </p>
      </div>
    );
  }
  return <AccessWindow />;
}

function AccessWindow() {
  const a = useAccess();
  const [tab, setTab] = useState<'people' | 'roles' | 'groups'>('people');
  const [personFilter, setPersonFilter] = useState('');
  const [permFilter, setPermFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const staffRows = a.staff.status === 'ready' ? a.staff.data.items : [];
  const groupRows = a.groups.status === 'ready' ? a.groups.data.items : [];

  const visiblePeople = useMemo(() => {
    const q = personFilter.trim().toLowerCase();
    if (!q) return staffRows;
    return staffRows.filter(
      (s) => s.email.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q),
    );
  }, [staffRows, personFilter]);

  const toggleSelected = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      // ⭐ Two answers to "whom am I editing" is the defect this window exists to kill: a live
      // multi-select IS the scope, immediately — never a checked list wired to nothing.
      a.setScope(next.size > 0 ? { kind: 'selection', userIds: [...next] } : null);
      return next;
    });
  };

  const pickPerson = (userId: string) => {
    setSelected(new Set());
    a.setScope({ kind: 'person', userId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="access-window">
      <header className="shrink-0 pb-4">
        <h1 className="text-lg font-semibold">Access management</h1>
        <p className="text-sm text-muted-foreground">
          Roles and permissions, one mechanism: pick who on the left, change what they may do on the
          right. Every change lands in the audit log and takes effect immediately.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* ── WHO: the left rail ─────────────────────────────────────────────────────────────── */}
        <nav className="flex w-80 shrink-0 flex-col" aria-label="Access subjects">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="w-full">
              <TabsTrigger value="people" className="flex-1" data-testid="tab-people">
                People
              </TabsTrigger>
              {/* Two AXES, kept visibly apart (0039): a role is what somebody IS, a group is what
                  they are IN — reading one as the other grants the wrong thing. */}
              <TabsTrigger value="roles" className="flex-1" data-testid="tab-roles">
                Roles
              </TabsTrigger>
              <TabsTrigger value="groups" className="flex-1" data-testid="tab-groups">
                Groups
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {tab === 'people' && (
              <>
                <Input
                  value={personFilter}
                  onChange={(e) => setPersonFilter(e.target.value)}
                  placeholder="Search people…"
                  aria-label="Search people"
                  data-testid="people-search"
                  className="mb-2"
                />
                {a.staff.status === 'loading' && <Skeleton className="h-24 w-full" />}
                {a.staff.status === 'error' && (
                  <ErrorState error={a.staff.error} onRetry={a.refresh} />
                )}
                {a.staff.status === 'empty' && (
                  <p className="px-1 text-sm text-muted-foreground">
                    Nobody here yet — invite people from People &amp; groups.
                  </p>
                )}
                <ul className="space-y-0.5" data-testid="access-people">
                  {visiblePeople.map((s) => (
                    <PersonRow
                      key={s.userId}
                      person={s}
                      active={a.scope?.kind === 'person' && a.scope.userId === s.userId}
                      checked={selected.has(s.userId)}
                      onCheck={() => toggleSelected(s.userId)}
                      onOpen={() => pickPerson(s.userId)}
                    />
                  ))}
                </ul>
              </>
            )}

            {tab === 'roles' && (
              <ul className="space-y-0.5" data-testid="access-roles">
                {/* ⛔ super_admin is absent by decision, not by omission (0033/FR-018). */}
                {ASSIGNABLE_ROLES.map((r) => (
                  <li key={r}>
                    <button
                      type="button"
                      data-testid={`role-${r}`}
                      aria-current={
                        a.scope?.kind === 'role' && a.scope.roleKey === r ? 'true' : undefined
                      }
                      onClick={() => {
                        setSelected(new Set());
                        a.setScope({ kind: 'role', roleKey: r });
                      }}
                      className={cn(
                        'w-full rounded-md px-3 py-2 text-left text-sm transition-colors duration-fast motion-reduce:transition-none',
                        a.scope?.kind === 'role' && a.scope.roleKey === r
                          ? 'bg-foreground font-medium text-background'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      {r}
                      <span className="mt-0.5 block text-xs font-normal opacity-70">
                        template — edits move everyone still inheriting it
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {tab === 'groups' && (
              <>
                {a.groups.status === 'loading' && <Skeleton className="h-24 w-full" />}
                {a.groups.status === 'error' && (
                  <ErrorState error={a.groups.error} onRetry={a.refresh} />
                )}
                {a.groups.status === 'empty' && (
                  <p className="px-1 text-sm text-muted-foreground">
                    No groups yet — desks are created in People &amp; groups; here they carry
                    grants.
                  </p>
                )}
                <ul className="space-y-0.5" data-testid="access-groups">
                  {groupRows.map((g) => (
                    <li key={g.id}>
                      <button
                        type="button"
                        data-testid={`group-${g.id}`}
                        aria-current={
                          a.scope?.kind === 'group' && a.scope.groupId === g.id ? 'true' : undefined
                        }
                        onClick={() => {
                          setSelected(new Set());
                          a.setScope({ kind: 'group', groupId: g.id });
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors duration-fast motion-reduce:transition-none',
                          a.scope?.kind === 'group' && a.scope.groupId === g.id
                            ? 'bg-foreground font-medium text-background'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <span className="truncate">{g.name}</span>
                        <span className="text-xs opacity-70">{g.memberCount}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </nav>

        {/* ── WHAT: the grid ─────────────────────────────────────────────────────────────────── */}
        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto" aria-label="Permissions">
          {a.scope === null ? (
            <div
              className="flex h-full items-center justify-center text-sm text-muted-foreground"
              data-testid="access-empty"
            >
              Pick a person, a role or a group on the left — the grid shows what they may do.
            </div>
          ) : (
            <Grid
              scope={a.scope}
              staff={staffRows}
              groups={groupRows}
              catalogue={a.catalogue}
              person={a.person}
              roleDefaults={a.roleDefaults}
              permFilter={permFilter}
              setPermFilter={setPermFilter}
              busyKey={a.busyKey}
              mutation={a.mutation}
              onTogglePerson={a.togglePerson}
              onToggleRole={a.toggleRole}
              onToggleGroup={a.toggleGroup}
              onApplySelection={a.applySelection}
              onReset={a.reset}
              onSetRole={a.setRole}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function PersonRow({
  person,
  active,
  checked,
  onCheck,
  onOpen,
}: {
  person: StaffWire;
  active: boolean;
  checked: boolean;
  onCheck: () => void;
  onOpen: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      {/* The checkbox builds the BATCH scope; the row itself opens the person. Two controls,
          two questions — merged they would make selecting and inspecting one gesture. */}
      <Checkbox
        checked={checked}
        onCheckedChange={onCheck}
        aria-label={`Select ${person.displayName || person.email}`}
        data-testid={`select-${person.userId}`}
      />
      <button
        type="button"
        data-testid={`person-${person.userId}`}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className={cn(
          'min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors duration-fast motion-reduce:transition-none',
          active ? 'bg-foreground text-background' : 'hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <span className="block truncate text-sm">{person.displayName || person.email}</span>
        <span className="flex items-center gap-1.5 text-xs opacity-70">
          {person.roleKey || 'no role'}
          {person.inheritsRole === false && (
            <Badge variant="outline" className="px-1 py-0 text-[10px]">
              personalised
            </Badge>
          )}
          {person.status !== 'active' && (
            <Badge variant="secondary" className="px-1 py-0 text-[10px]">
              {person.status}
            </Badge>
          )}
        </span>
      </button>
    </li>
  );
}

function Grid({
  scope,
  staff,
  groups,
  catalogue,
  person,
  roleDefaults,
  permFilter,
  setPermFilter,
  busyKey,
  mutation,
  onTogglePerson,
  onToggleRole,
  onToggleGroup,
  onApplySelection,
  onReset,
  onSetRole,
}: {
  scope: Scope;
  staff: StaffWire[];
  groups: GroupWire[];
  catalogue: ReturnType<typeof useAccess>['catalogue'];
  person: ReturnType<typeof useAccess>['person'];
  roleDefaults: ReturnType<typeof useAccess>['roleDefaults'];
  permFilter: string;
  setPermFilter: (v: string) => void;
  busyKey: string | null;
  mutation: ReturnType<typeof useAccess>['mutation'];
  onTogglePerson: (userId: string, key: string, grant: boolean) => void;
  onToggleRole: (roleKey: string, key: string, grant: boolean) => void;
  onToggleGroup: (groupId: string, key: string, grant: boolean) => void;
  onApplySelection: (userIds: string[], key: string, grant: boolean) => void;
  onReset: (s: Scope) => void;
  onSetRole: (userId: string, roleKey: string) => void;
}) {
  const subject = subjectOf(scope, staff, groups);
  const personData: PersonPermissionsWire | null =
    person.status === 'ready' ? person.data : null;
  const roleKeys = roleDefaults.status === 'ready' ? new Set(roleDefaults.data.permissionKeys) : null;
  const group = scope.kind === 'group' ? groups.find((g) => g.id === scope.groupId) : undefined;
  const groupGranted = new Set(group?.permissionKeys ?? []);

  // FR-011, surfaced BEFORE the server's 409: a batch spans one role or the engine refuses it.
  const selectionRoles =
    scope.kind === 'selection'
      ? [...new Set(staff.filter((s) => scope.userIds.includes(s.userId)).map((s) => s.roleKey))]
      : [];
  const crossRole = selectionRoles.length > 1;

  const loading =
    (scope.kind === 'person' && person.status === 'loading') ||
    (scope.kind === 'role' && roleDefaults.status === 'loading') ||
    catalogue.status === 'loading';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── the scope header: WHO is being edited, their role, and the way back ───────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" data-testid="scope-title">
            {subject.title}
          </h2>
          <p className="text-xs text-muted-foreground">{subject.hint}</p>
        </div>

        {scope.kind === 'person' && personData && (
          <>
            {personData.mode === 'standalone' && (
              <Badge variant="outline" data-testid="mode-standalone">
                personalised — role changes stop moving their access
              </Badge>
            )}
            {/* ⭐ R45: the role is handed out in the SAME window. super_admin is not an option. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" data-testid="role-menu" disabled={busyKey !== null}>
                  role: {staff.find((s) => s.userId === scope.userId)?.roleKey || '—'} ▾
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {ASSIGNABLE_ROLES.map((r) => (
                  <DropdownMenuItem
                    key={r}
                    data-testid={`assign-role-${r}`}
                    onSelect={() => onSetRole(scope.userId, r)}
                  >
                    {r}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {scope.kind !== 'group' && (
          <Button
            variant="outline"
            size="sm"
            data-testid="reset-scope"
            disabled={busyKey !== null}
            onClick={() => onReset(scope)}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
            Reset to defaults
          </Button>
        )}
      </div>

      {crossRole && (
        <p
          className="mt-2 shrink-0 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
          data-testid="cross-role-warning"
        >
          The selection spans {selectionRoles.length} roles — the engine applies a batch to one role
          at a time and will refuse this one. Narrow the selection.
        </p>
      )}
      {mutation && (
        <p className="mt-2 shrink-0 text-xs text-destructive" data-testid="access-mutation-error">
          {mutation.message}
        </p>
      )}

      <Input
        value={permFilter}
        onChange={(e) => setPermFilter(e.target.value)}
        placeholder="Filter permissions…"
        aria-label="Filter permissions"
        data-testid="perm-search"
        className="mt-3 shrink-0"
      />

      <div className="min-h-0 flex-1 overflow-y-auto pt-2">
        {loading && <Skeleton className="h-40 w-full" />}
        {catalogue.status === 'error' && <ErrorState error={catalogue.error} />}
        {person.status === 'error' && scope.kind === 'person' && (
          <ErrorState error={person.error} />
        )}

        {!loading &&
          catalogue.status === 'ready' &&
          filterCatalogue(catalogue.data, permFilter).categories.map((cat) => (
            <section key={cat.category} className="mb-4" data-testid={`category-${cat.category}`}>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {cat.category}
              </h3>
              <ul className="divide-y divide-border rounded-md border border-border">
                {cat.permissions.map((p) => {
                  const viaGroup = scope.kind === 'person' && !!personData?.groupKeys.includes(p.key);
                  const on =
                    scope.kind === 'person'
                      ? !!personData?.baseKeys.includes(p.key)
                      : scope.kind === 'role'
                        ? !!roleKeys?.has(p.key)
                        : scope.kind === 'group'
                          ? groupGranted.has(p.key)
                          : false;
                  return (
                    <li
                      key={p.key}
                      className="flex items-center gap-3 px-3 py-2"
                      data-testid={`perm-${p.key}`}
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{p.label}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {p.key}
                        </span>
                      </div>
                      {viaGroup && (
                        <Badge variant="secondary" data-testid={`via-group-${p.key}`}>
                          via group
                        </Badge>
                      )}
                      {scope.kind === 'selection' ? (
                        // Write-only by design: N people have no single truth a switch could show.
                        <span className="flex gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`grant-${p.key}`}
                            disabled={busyKey !== null || crossRole}
                            onClick={() => onApplySelection(scope.userIds, p.key, true)}
                          >
                            Grant
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`revoke-${p.key}`}
                            disabled={busyKey !== null || crossRole}
                            onClick={() => onApplySelection(scope.userIds, p.key, false)}
                          >
                            Revoke
                          </Button>
                        </span>
                      ) : (
                        <Switch
                          checked={on}
                          disabled={busyKey !== null}
                          aria-label={`${p.label} — ${on ? 'granted' : 'not granted'}`}
                          data-testid={`switch-${p.key}`}
                          onCheckedChange={(next) => {
                            if (scope.kind === 'person') onTogglePerson(scope.userId, p.key, next);
                            else if (scope.kind === 'role') onToggleRole(scope.roleKey, p.key, next);
                            else if (scope.kind === 'group') onToggleGroup(scope.groupId, p.key, next);
                          }}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}

function subjectOf(scope: Scope, staff: StaffWire[], groups: GroupWire[]) {
  switch (scope.kind) {
    case 'person': {
      const s = staff.find((x) => x.userId === scope.userId);
      return {
        title: s ? s.displayName || s.email : scope.userId,
        hint: 'The switches are this person’s own set; keys arriving via a group are marked and edited on the group.',
      };
    }
    case 'selection':
      return {
        title: `${scope.userIds.length} people selected`,
        hint: 'A batch applies one change to everyone selected — actions, not switches: N people have no single state to show.',
      };
    case 'role':
      return {
        title: `Role template: ${scope.roleKey}`,
        hint: 'Edits move everyone still inheriting this role. Personalised people keep their snapshot until reset.',
      };
    case 'group': {
      const g = groups.find((x) => x.id === scope.groupId);
      return {
        title: `Group: ${g?.name ?? scope.groupId}`,
        hint: 'A group GRANTS on top of roles and never denies (0039). Members receive these keys while they belong.',
      };
    }
  }
}

function filterCatalogue(c: CatalogueWire, q: string): CatalogueWire {
  const needle = q.trim().toLowerCase();
  if (!needle) return c;
  return {
    categories: c.categories
      .map((cat) => ({
        ...cat,
        permissions: cat.permissions.filter(
          (p) => p.key.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle),
        ),
      }))
      .filter((cat) => cat.permissions.length > 0),
  };
}
