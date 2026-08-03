'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { MODULE_CATALOGUE, parseModuleOverrides, resolveModules } from './nav-items';
import { useSession } from '@/session';

/**
 * Command-palette host (⌘K / Ctrl+K). Open state is owned by the shell so the topbar search button
 * can open it too.
 *
 * ⚠️ **Feature 029: it resolves the SAME module list as the rail, and that is the point.** A palette
 * offering a destination the sidebar hides is a way around the sidebar — and a much quieter one,
 * because nobody looks at a search box to audit navigation. Both call `resolveModules`; neither has
 * a list of its own.
 *
 * ⛔ Still rendering, not enforcement: a route the person may not use refuses server-side regardless
 * of whether anything offered to navigate there (roadmap 9.14).
 */
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { state } = useSession();
  const permissionKeys = state.kind === 'authenticated' ? state.permissionKeys : [];
  const modules = resolveModules(
    permissionKeys,
    parseModuleOverrides(process.env.NEXT_PUBLIC_MODULE_STATES),
    MODULE_CATALOGUE,
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {modules.map((item) => (
            <CommandItem
              key={item.key}
              onSelect={() => {
                onOpenChange(false);
                router.push(item.href);
              }}
            >
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
