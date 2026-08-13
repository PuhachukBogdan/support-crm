'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/composites/page-header/page-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '@/session';
import { usePeople, useGroupMembers } from './use-people';
import { ASSIGNABLE_ROLES, type StaffWire } from './types';

/**
 * W14 — People & groups (roadmap 3.8 + 3.9): the two axes of one admin screen.
 *
 * ⚠️⚠️ **Two authorization models meet here, and the screen states which is which rather than
 * blurring them.** Seeing the list is `users.list.view` (supervisory); changing a ROLE is
 * super-admin only; managing desks is `platform.group.manage`. A teamlead therefore sees everybody
 * and can change nobody's role — so the role control is not rendered for them, and if the server
 * refuses anyway the message says so beside the list instead of blanking it.
 *
 * ⛔ **No permission matrix here.** 3.8 says *«минимум, без матрицы тумблеров»* — per-permission
 * editing is 9.8's own screen, and putting a grid of toggles on the same page as role changes is
 * how an administrator grants something they meant only to look at.
 * ⛔ **No deactivation.** Nothing in the product writes `disabled`, and 3.16 is blocked on the
 * backlog that would receive a leaver's tickets — a button that only flips a column would strand
 * their open work silently.
 */
export function People() {
  const { staff, groups, mutation, setRole, setMembership } = usePeople();
  const session = useSession();
  const roles = session.state.kind === 'authenticated' ? session.state.roles : [];
  // Render-only, as always: the server refuses regardless, this just avoids offering a 403.
  const maySetRole = roles.includes('super_admin');
  const [openGroup, setOpenGroup] = useState('');

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="People & groups" />

      {mutation && (
        <p className="rounded-md border border-destructive/40 p-2 text-sm text-destructive" data-testid="people-error">
          {mutation.message}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">People</h2>
        {staff.status === 'ready' ? (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="people-list">
            {staff.data.items.map((p) => (
              <PersonRow key={p.userId} person={p} maySetRole={maySetRole} onSetRole={setRole} />
            ))}
          </ul>
        ) : staff.status === 'error' ? (
          <p className="text-sm text-destructive" data-testid="people-list-error">
            {staff.error.message}
          </p>
        ) : staff.status === 'empty' ? (
          <p className="text-sm text-muted-foreground">No people in this account yet.</p>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Desks</h2>
        {groups.status === 'ready' ? (
          <ul className="space-y-2" data-testid="groups-list">
            {groups.data.items.map((g) => (
              <li key={g.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-muted-foreground">{g.memberCount} members</span>
                  {!g.active && <Badge variant="outline">inactive</Badge>}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    data-testid={`group-open-${g.id}`}
                    onClick={() => setOpenGroup(openGroup === g.id ? '' : g.id)}
                  >
                    {openGroup === g.id ? 'Hide members' : 'Members'}
                  </Button>
                </div>
                {openGroup === g.id && (
                  <GroupMembers
                    groupId={g.id}
                    staff={staff.status === 'ready' ? staff.data.items : []}
                    onToggle={setMembership}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : groups.status === 'error' ? (
          // Desks and people are different keys — one half being refused must not blank the other.
          <p className="text-sm text-muted-foreground" data-testid="groups-error">
            Desks are not available to your role.
          </p>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </section>
    </div>
  );
}

function PersonRow({
  person,
  maySetRole,
  onSetRole,
}: {
  person: StaffWire;
  maySetRole: boolean;
  onSetRole: (userId: string, roleKey: string) => Promise<boolean>;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 p-2 text-sm" data-testid={`person-${person.userId}`}>
      <div className="min-w-0 flex-1">
        {/* The email is the identity: `display_name` is optional and frequently unset, and a name
            invented from an address is a guess wearing a person's clothes. */}
        <div className="truncate">{person.email}</div>
        {person.displayName && <div className="truncate text-xs text-muted-foreground">{person.displayName}</div>}
      </div>
      {person.status !== 'active' && <Badge variant="outline">{person.status}</Badge>}
      {/* ⭐⭐ Personalised people no longer follow their role — a role change would move the word
          beside their name and nothing else. Said here, because the alternative is a control that
          silently does nothing (found live in W14). */}
      {person.inheritsRole === false && (
        <Badge variant="outline" title="Permissions were personalised, so a role change will not move this person's access until they are reset to defaults" data-testid={`personalised-${person.userId}`}>
          personalised
        </Badge>
      )}
      <span className="w-32 shrink-0 text-xs text-muted-foreground" data-testid={`role-${person.userId}`}>
        {person.roleKey || 'no role'}
      </span>
      {maySetRole ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-testid={`set-role-${person.userId}`}>
              Change role
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ASSIGNABLE_ROLES.map((r) => (
              <DropdownMenuItem key={r} onSelect={() => void onSetRole(person.userId, r)}>
                {r}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // ⛔ Not a disabled button: a control nobody in this role can ever use is noise, and the
        // refusal it would produce is the server's business, not a tooltip's.
        <span className="w-28 shrink-0" />
      )}
    </li>
  );
}

/**
 * A desk's membership. ⚠️ The server returns bare USER IDS — it stores no names for members — so
 * the ids are joined against the people list this screen already has. That join is also why the
 * two halves live on one screen: separately, the desks page would render UUIDs.
 */
function GroupMembers({
  groupId,
  staff,
  onToggle,
}: {
  groupId: string;
  staff: StaffWire[];
  onToggle: (groupId: string, userId: string, member: boolean) => Promise<boolean>;
}) {
  const userIds = useGroupMembers(groupId);
  if (userIds === null) return <Skeleton className="mt-2 h-12 w-full" />;
  const members = new Set(userIds);

  return (
    <ul className="mt-2 space-y-1" data-testid={`group-members-${groupId}`}>
      {staff.map((p) => (
        <li key={p.userId} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">{p.email}</span>
          <Button
            size="sm"
            variant={members.has(p.userId) ? 'secondary' : 'ghost'}
            data-testid={`member-toggle-${groupId}-${p.userId}`}
            onClick={() => void onToggle(groupId, p.userId, !members.has(p.userId))}
          >
            {members.has(p.userId) ? 'Remove' : 'Add'}
          </Button>
        </li>
      ))}
      {userIds.filter((id) => !staff.some((p) => p.userId === id)).length > 0 && (
        // Honest about a mismatch rather than hiding it: a member the people list does not contain
        // is a real state (a second page, or a user removed from the account), and silently
        // dropping them would make the desk look smaller than it is.
        <li className="text-xs text-muted-foreground" data-testid={`group-unknown-${groupId}`}>
          {userIds.filter((id) => !staff.some((p) => p.userId === id)).length} member(s) not on this
          page of the people list.
        </li>
      )}
    </ul>
  );
}
