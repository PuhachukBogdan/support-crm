'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/composites/data-table/data-table';
import { PageHeader } from '@/components/composites/page-header/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { AsyncState, PaginatedResult } from '@/data/types';
import { useBrands } from './use-brands';
import { useDirectory } from './use-directory';
import type { DirectoryRow } from './types';

/**
 * W11 — the customer directory (roadmap 9.17, the list half).
 *
 * ── Three things this screen is NOT, and each absence is a decision ──────────────────────────────
 * ⛔ **It has no contact search.** Typing a phone number to learn whose it is is the anti-pitching
 *    INVERSION; it lives only inside an unidentified conversation, audited with a hash and
 *    rate-capped (ADR 0044 §4). Here you search by the PLATFORM ID you already have. There is no
 *    email or phone parameter on the route, and the transport refuses one client-side too.
 * ⛔ **It does not show a name.** The product stores none at any tier (research R9) — names live in
 *    GR8 (5.4). The columns are ids and whatever the caller's tier permits.
 * ⛔ **It does not filter itself for a role that may not read it.** A support agent gets the
 *    server's REFUSAL, said in words — not an empty table that reads like "no customers". That is
 *    9.17's own *Done when*, and the guard has been in force server-side since feature 018.
 *
 * ⚠️ And it always asks about ONE brand: the same platform id under two brands is two human beings
 * (the 2026-07-29 Person repair), so there is no "all brands" option to offer.
 */
export function Contacts() {
  const router = useRouter();
  const brands = useBrands();
  const [brandId, setBrandId] = useState('');
  const [draft, setDraft] = useState('');
  const [prefix, setPrefix] = useState('');

  // The first brand becomes the default the moment the list answers — a chooser with nothing
  // chosen would make the screen look broken while it is merely waiting.
  const activeBrand = brandId || brands.brands[0]?.brandId || '';

  /**
   * ⚠️ **No brand ⇒ no request at all.** An earlier draft passed a placeholder brand so the hook
   * would have something to send — which is a real request for a brand that does not exist, and
   * exactly the kind of phantom call that later reads as a mysterious 404 in a log. The list hook
   * therefore takes `null` and holds.
   */
  const list = useDirectory(activeBrand, prefix);

  const openPlayer = useCallback(
    (playerId: string) =>
      router.push(`/players/${encodeURIComponent(activeBrand)}/${encodeURIComponent(playerId)}`),
    [router, activeBrand],
  );

  const columns = useMemo<ColumnDef<DirectoryRow, unknown>[]>(
    () => [
      {
        id: 'playerId',
        header: 'Player',
        size: 220,
        cell: ({ row }: { row: { original: DirectoryRow } }) => (
          <span className="font-mono text-xs">{row.original.playerId}</span>
        ),
      },
      {
        id: 'vip',
        header: 'VIP',
        size: 80,
        meta: { tier: 'contextual' },
        cell: ({ row }: { row: { original: DirectoryRow } }) =>
          // ⚠️ Absence is ambiguous here (not a VIP, or not for your tier) — so the cell renders a
          // badge or nothing at all, and never a word that would resolve the ambiguity falsely.
          row.original.vip ? <Badge variant="secondary">VIP</Badge> : null,
      },
      {
        id: 'segment',
        header: 'Segment',
        size: 160,
        meta: { tier: 'contextual' },
        cell: ({ row }: { row: { original: DirectoryRow } }) => row.original.segment ?? '',
      },
      {
        id: 'personId',
        header: 'Person',
        size: 220,
        meta: { tier: 'optional' },
        cell: ({ row }: { row: { original: DirectoryRow } }) => (
          <span className="font-mono text-xs">{row.original.personId ?? ''}</span>
        ),
      },
    ],
    [],
  );

  /**
   * ⭐ 9.17's *Done when*: "a linear role is refused the directory by the server". A 403 arrives as
   * a non-retryable DataError; rendering it as the table's generic error row would read like a
   * hiccup. It is not a hiccup — it is the answer.
   */
  const refused = list.status === 'error' && !list.error.retryable;

  const state: AsyncState<PaginatedResult<DirectoryRow>> = list;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader title="Customers" />

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {brands.loading ? (
          <Skeleton className="h-8 w-40" />
        ) : brands.failed ? (
          <span className="text-xs text-destructive" data-testid="brands-failed">
            Brands are unavailable, so the directory cannot be scoped to one.
          </span>
        ) : (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Brand" data-testid="brand-chooser">
            {brands.brands.map((b) => (
              <button
                key={b.brandId}
                type="button"
                data-testid={`brand-${b.brandId}`}
                aria-pressed={b.brandId === activeBrand}
                onClick={() => setBrandId(b.brandId)}
                className={`rounded px-2 py-1 text-xs ${
                  b.brandId === activeBrand ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {b.name || b.brandId}
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Input
            data-testid="player-id-search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setPrefix(draft.trim());
            }}
            // ⛔ The placeholder says what this searches, so nobody types a phone number into it
            // expecting the answer W9 deliberately keeps inside a conversation.
            placeholder="Search by player ID"
            aria-label="Search by player ID"
            className="h-8 w-56 text-sm"
          />
          <Button size="sm" variant="outline" data-testid="player-id-search-go" onClick={() => setPrefix(draft.trim())}>
            Search
          </Button>
          {prefix && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="player-id-search-clear"
              onClick={() => {
                setDraft('');
                setPrefix('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {refused ? (
        <div className="rounded-md border border-border p-6 text-sm" data-testid="directory-refused">
          <p className="font-medium">This directory is not available to your role.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Reading customers in bulk is limited to supervisory roles. Individual customers are
            still visible from the tickets you work on.
          </p>
        </div>
      ) : (
        <DataTable<DirectoryRow>
          columns={columns}
          state={state}
          getRowId={(row) => row.playerId}
          onRetry={list.refetch}
          onRowOpen={openPlayer}
          emptyLabel={prefix ? 'No customer with that ID prefix in this brand.' : 'No customers in this brand.'}
        />
      )}
    </div>
  );
}
