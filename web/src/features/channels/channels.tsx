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
import { useChannels } from './use-channels';
import type { BrandWire, ChannelWire } from './types';

/**
 * W15 — the Channels section of the Admin Center (roadmap 6.8 minimum, subpoint 3.10; frame
 * `admin-center/058`, proportions not pixels).
 *
 * What it is: the configured channels as a table — brand, kind, KEY, address, state — and the one
 * write the operator named: a brand's mail address. The API channel's key is the thing he asked to
 * SEE; it is the public identifier a delivery names, and it is shown in full because the secret is
 * a different value that lives in deployment configuration and has no column to be read from.
 *
 * ⛔ No enable/disable toggle, no widget registration, no desk binding — the rest of 6.8, each item
 * still owned there. ⚠️ And said on the screen: adding a mail address records the row; connecting
 * the MAILBOX (reader credentials) is deployment configuration (subpoint 2.1h) — a labelled state,
 * not a silent hope.
 *
 * There is no client-side permission gating here: list and write ride ONE key
 * (`platform.settings.manage`), so whoever the list answers may also write, and whoever it refuses
 * sees the refusal in words (the W11 rule) rather than an empty table.
 */
export function Channels() {
  const { channels, brands, setEmailAddress } = useChannels();
  const brandName = (id: string) => brands.find((b) => b.brandId === id)?.name || id;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 overflow-y-auto py-2">
      <PageHeader title="Channels" />

      {channels.status === 'ready' ? (
        <ChannelTable items={channels.data.items} brandName={brandName} onSetAddress={setEmailAddress} />
      ) : channels.status === 'error' ? (
        <p className="text-sm text-destructive" data-testid="channels-error">
          {channels.error.message}
        </p>
      ) : channels.status === 'empty' ? (
        // An account with no channels is a real state (a fresh deployment) — said, not blanked.
        <p className="text-sm text-muted-foreground" data-testid="channels-empty">
          No channels are configured for this account yet.
        </p>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}

      {channels.status === 'ready' && (
        <AddEmailAddress
          brands={brands.filter(
            (b) => !channels.data.items.some((c) => c.kind === 'email' && c.brandId === b.brandId),
          )}
          onSetAddress={setEmailAddress}
        />
      )}
    </div>
  );
}

function ChannelTable({
  items,
  brandName,
  onSetAddress,
}: {
  items: ChannelWire[];
  brandName: (id: string) => string;
  onSetAddress: (brandId: string, address: string) => Promise<DataError | null>;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border" data-testid="channels-list">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 p-3 text-sm" data-testid={`channel-${c.id}`}>
          <span className="w-40 shrink-0 truncate font-medium">{brandName(c.brandId)}</span>
          <Badge variant="outline">{c.kind}</Badge>
          {/* ⭐ The key — what the operator asked to SEE. For `api` it is the path segment of the
              intake URL; for `email` it is what the mailbox reader is configured with. Not a
              secret: that is a different value, held in deployment config, with no column here. */}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid={`channel-key-${c.id}`}>
            {c.key}
          </code>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid={`channel-address-${c.id}`}>
            {c.kind === 'email' ? c.address || '— no address recorded' : ''}
          </span>
          {!c.enabled && (
            // The stop button's state, visible at last. Flipping it back is not this block's write.
            <Badge variant="outline" data-testid={`channel-disabled-${c.id}`}>
              disabled — not taking work in
            </Badge>
          )}
          {c.kind === 'email' && <ChangeAddress channel={c} onSetAddress={onSetAddress} />}
        </li>
      ))}
    </ul>
  );
}

/** Change one email channel's address, inline — the outcome stays beside the control. */
function ChangeAddress({
  channel,
  onSetAddress,
}: {
  channel: ChannelWire;
  onSetAddress: (brandId: string, address: string) => Promise<DataError | null>;
}) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(channel.address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const failure = await onSetAddress(channel.brandId, address.trim());
    setBusy(false);
    if (failure) setError(failure);
    else setOpen(false); // the refreshed row is the receipt
  };

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid={`change-address-${channel.id}`}
        onClick={() => {
          // Re-seed from the CURRENT row: the initializer ran once, and after a save + refresh a
          // reopened form would otherwise offer the address from before the change.
          setAddress(channel.address);
          setOpen(true);
        }}
      >
        Change address
      </Button>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        type="email"
        required
        className="w-64"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        data-testid={`address-input-${channel.id}`}
      />
      <Button type="submit" size="sm" disabled={busy || !address.includes('@')} data-testid={`address-save-${channel.id}`}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && (
        <p className="w-full text-sm text-destructive" data-testid={`address-error-${channel.id}`}>
          {error.message}
        </p>
      )}
    </form>
  );
}

/**
 * A brand with no email channel yet gets its first mail address here. Absent when every brand has
 * one — a control with nothing to act on is noise.
 */
function AddEmailAddress({
  brands,
  onSetAddress,
}: {
  brands: BrandWire[];
  onSetAddress: (brandId: string, address: string) => Promise<DataError | null>;
}) {
  const [brandId, setBrandId] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const [added, setAdded] = useState(false);

  if (brands.length === 0) return null;
  const chosen = brands.find((b) => b.brandId === brandId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setAdded(false);
    const failure = await onSetAddress(brandId, address.trim());
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setAdded(true);
    setBrandId('');
    setAddress('');
  };

  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="add-email-form">
      <h2 className="text-sm font-medium">Add a mail address</h2>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-testid="add-email-brand">
              {chosen ? chosen.name : 'Choose a brand'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {brands.map((b) => (
              <DropdownMenuItem key={b.brandId} onSelect={() => setBrandId(b.brandId)}>
                {b.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          type="email"
          required
          placeholder="support@brand.example"
          className="w-64"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          data-testid="add-email-address"
        />
        <Button type="submit" size="sm" disabled={busy || !brandId || !address.includes('@')} data-testid="add-email-save">
          Add address
        </Button>
      </form>
      {added && (
        <p className="text-sm text-muted-foreground" data-testid="add-email-done">
          Address recorded — it appears in the list above.
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" data-testid="add-email-error">
          {error.message}
        </p>
      )}
      {/* The honest boundary (subpoint 2.1h): the row is ours to write, the mailbox is not. */}
      <p className="text-xs text-muted-foreground">
        Recording an address does not connect the mailbox itself — the mail reader and its
        credentials are deployment configuration, set by whoever operates the stand.
      </p>
    </section>
  );
}
